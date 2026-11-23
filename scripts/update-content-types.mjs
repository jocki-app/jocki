import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
const root = "registries/jocki-content-types/",
  source = JSON.parse(await readFile(root + "source.json", "utf8"));
const commit = process.argv[2] ?? source.commit;
if (!/^[a-f0-9]{40}$/.test(commit))
  throw Error("Pass a full, reviewed registry commit SHA");
const get = async (name) => {
  const response = await fetch(
    `https://raw.githubusercontent.com/jocki/jocki-content-types/${commit}/${name}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) throw Error(`Registry ${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) throw Error("Registry exceeds size limit");
  return new TextDecoder().decode(bytes);
};
const [yaml, json] = await Promise.all([
  get("registry.yaml"),
  get("registry.json"),
]);
if (JSON.stringify(YAML.parse(yaml), null, 2) + "\n" !== json)
  throw Error("Registry YAML and JSON differ");
const previousYAML = await readFile(root + "registry.yaml", "utf8"),
  previousJSON = await readFile(root + "registry.json", "utf8");
await writeFile(root + "registry.yaml", yaml);
await writeFile(root + "registry.json", json);
const validation = spawnSync(
  process.execPath,
  [root + "generate.mjs", "--check"],
  { stdio: "inherit" },
);
if (validation.status !== 0) {
  await writeFile(root + "registry.yaml", previousYAML);
  await writeFile(root + "registry.json", previousJSON);
  throw Error("Registry validation failed; previous snapshot restored");
}
await writeFile(
  root + "source.json",
  JSON.stringify({ repository: source.repository, commit }, null, 2) + "\n",
);
console.log("Updated registry to reviewed commit " + commit);
