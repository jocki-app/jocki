import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const image = process.env.JOCKI_IMAGE ?? "jocki-peer:verified",
  name = "jocki-file-persistence-" + process.pid,
  volume = name + "-data",
  vaultVolume = name + "-vault";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const mounts = [
  "--mount",
  "type=volume,source=" + volume + ",target=/data",
  "--mount",
  "type=volume,source=" + vaultVolume + ",target=/vaults",
];
async function start(ui) {
  docker(
    "run",
    "-d",
    "--name",
    name,
    ...mounts,
    "-p",
    "127.0.0.1::8080",
    "-e",
    "JOCKI_SERVE_UI=" + (ui ? 1 : 0),
    "-e",
    'JOCKI_VAULTS=["/vaults/Main"]',
    image,
  );
  const url =
    "http://127.0.0.1:" + docker("port", name, "8080/tcp").split(":").at(-1);
  for (let i = 0; i < 90; i++) {
    const state = JSON.parse(
      docker("inspect", "--format", "{{json .State}}", name),
    );
    assert.ok(
      state.Running,
      `Container stopped before becoming ready: ${state.ExitCode}`,
    );
    const response = await fetch(url + "/api/health", {
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
    if (response?.ok) {
      const health = await response.json();
      assert.equal(health.format, "saddle-workspace/1");
      assert.equal(health.vaults, 1);
      assert.equal(health.ui, ui);
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error("Container health check timed out");
}
function fingerprint() {
  return docker(
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `
 import {NodeFSStorageAdapter} from '@automerge/automerge-repo-storage-nodefs';import {createHash} from 'node:crypto';
 const bytes=await new NodeFSStorageAdapter('/data/replica-cache/identity').load(['active-key-pair-2']);
 if(!bytes)throw Error('Missing identity');console.log(createHash('sha256').update(bytes).digest('hex'));
 `,
  );
}
try {
  docker("volume", "create", volume);
  docker("volume", "create", vaultVolume);
  // Opening a folder requires that it already exists, including inside a fresh volume.
  docker(
    "run",
    "--rm",
    ...mounts,
    image,
    "node",
    "-e",
    "require('node:fs').mkdirSync('/vaults/Main',{recursive:true})",
  );
  const first = await start(false);
  assert.equal((await fetch(first)).status, 404);
  const identity = fingerprint();
  docker(
    "exec",
    name,
    "node",
    "-e",
    `require('node:fs').writeFileSync('/vaults/Main/example.md','# Persistent file\\n')`,
  );
  let indexed = false;
  for (let i = 0; i < 20; i++) {
    indexed =
      docker(
        "exec",
        name,
        "node",
        "-e",
        `const fs=require('node:fs'), path=require('node:path'); console.log(fs.readdirSync('/data/state/roots').some(root=>{const p=path.join('/data/state/roots',root,'root-index.json');return fs.existsSync(p)&&Object.values(JSON.parse(fs.readFileSync(p,'utf8')).files).some(file=>file.path==='example.md'&&!file.deleted)}))`,
      ) === "true";
    if (indexed) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(indexed, "External save was not indexed");
  docker("stop", "-t", "40", name);
  docker("rm", name);
  docker(
    "run",
    "--rm",
    ...mounts,
    image,
    "node",
    "dist-peer/main.js",
    "--export-workspace",
    "/data/settings.automerge",
  );
  const second = await start(true);
  assert.equal((await fetch(second)).status, 200);
  assert.equal(fingerprint(), identity);
  assert.match(
    docker(
      "exec",
      name,
      "node",
      "-e",
      `console.log(require('node:fs').readFileSync('/vaults/Main/example.md','utf8'))`,
    ),
    /Persistent file/,
  );
  console.log(
    "Verified container vault persistence, filesystem watching, stable identity, settings export and optional UI.",
  );
} catch (error) {
  try {
    console.error(docker("logs", "--tail", "25", name));
  } catch {}
  throw error;
} finally {
  for (const args of [
    ["rm", "-f", name],
    ["volume", "rm", volume],
    ["volume", "rm", vaultVolume],
  ])
    try {
      docker(...args);
    } catch {}
}
