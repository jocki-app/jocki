import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicKey } from "node:crypto";
import { verifyArtifact } from "@jocki/platform/plugin-sdk/artifact";
import { packPlugin } from "../packages/platform-node/compat/plugin-packages";

const [directory, keyFile, output] = process.argv.slice(2);
if (!directory || !keyFile || !output)
  throw Error(
    "Usage: npm run plugin:pack -- <built-package-directory> <private-key.pem> <output.zip>",
  );
const root = await realpath(directory);
const key = await realpath(keyFile);
const target = path.join(
  await realpath(path.dirname(path.resolve(output))),
  path.basename(output),
);
for (const file of [key, target]) {
  const relative = path.relative(root, path.resolve(file));
  if (!relative.startsWith(".." + path.sep) && relative !== "..")
    throw Error(
      "Keep the signing key and output ZIP outside the package directory",
    );
}
const signingKey = await readFile(key, "utf8");
const bytes = await packPlugin(root, signingKey);
const { publisher } = JSON.parse(
  await readFile(path.join(root, "plugin.json"), "utf8"),
);
await verifyArtifact(bytes, {
  [publisher]: createPublicKey(signingKey)
    .export({ type: "spki", format: "pem" })
    .toString(),
});
await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
console.log(`Created signed plugin package: ${output}`);
