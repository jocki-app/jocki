import { NodeVaultFiles } from "../packages/platform-node/vault-files";
import { Companions } from "../packages/core/vaults/companions";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as A from "@automerge/automerge";
import { createHash } from "node:crypto";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
const directory = await mkdtemp(path.join(os.tmpdir(), "jocki-file-cli-"));
const run = (...args: string[]) =>
  execFileSync(process.execPath, ["dist-peer/main.js", ...args], {
    encoding: "utf8",
    timeout: 45000,
    env: { ...process.env, JOCKI_VAULTS: "[]", JOCKI_SYNC_CONFIG: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
const fingerprint = async (data: string) => {
  const bytes = await new NodeFSStorageAdapter(
    path.join(data, "replica-cache/identity"),
  ).load(["active-key-pair-2"]);
  assert.ok(bytes);
  return createHash("sha256").update(bytes).digest("hex");
};
try {
  const data = path.join(directory, "first"),
    folder = path.join(directory, "vault"),
    bundle = path.join(directory, "workspace.automerge");
  await mkdir(folder);
  await writeFile(path.join(folder, "notes.md"), "# CLI file\n");
  const sidecar = JSON.stringify({
    name: "notes",
    path: "notes.md",
    metadata: { owner: "CLI" },
  });
  const files = await NodeVaultFiles.open(folder),
    companions = new Companions(files);
  await companions.write(
    "notes.md",
    "resource.json",
    new TextEncoder().encode(sidecar),
  );
  run(
    "--data",
    data,
    "--vault",
    folder,
    "--name",
    "CLI workspace",
    "--export-workspace",
    bundle,
  );
  const doc = A.load<{ format: string; id: string; name: string }>(
    new Uint8Array(await readFile(bundle)),
  );
  assert.equal(doc.format, "saddle-workspace/1");
  assert.equal(doc.name, "CLI workspace");
  const first = fingerprint(data);
  assert.ok(
    Object.keys(JSON.parse(run("--data", data, "--contact-card"))).length,
  );
  run("--data", data, "--contact-card");
  assert.equal(await fingerprint(data), await first);
  run("--data", path.join(directory, "second"), "--import-workspace", bundle);
  assert.notEqual(
    await fingerprint(path.join(directory, "second")),
    await first,
  );
  const adopted = JSON.parse(
    await readFile(
      path.join(directory, "second/workspace/workspace.json"),
      "utf8",
    ),
  );
  assert.equal(adopted.id, doc.id);
  // The imported identity must also replace the internal workspace index key.
  run("--data", path.join(directory, "second"), "--once");
  const manifest = () => companions.descriptor("notes.md");
  const id = (await manifest())!.id;
  run("--data", data, "--once");
  assert.equal((await manifest())!.id, id);
  assert.equal(
    await readFile(path.join(folder, "notes.md"), "utf8"),
    "# CLI file\n",
  );
  assert.deepEqual(
    JSON.parse(
      new TextDecoder().decode(
        await companions.read("notes.md", "resource.json"),
      ),
    ),
    JSON.parse(sidecar),
  );
  assert.ok(
    !(await readdir(folder, { recursive: true })).some((name) =>
      name.endsWith(".automerge"),
    ),
  );
  console.log(
    "Verified file-vault CLI, persistent identity, settings export/adoption and restart.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
