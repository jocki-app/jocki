import { spawn, spawnSync } from "node:child_process";
delete process.env.ELECTRON_RUN_AS_NODE;
if (!process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  const runtime = spawnSync(
    process.execPath,
    ["node_modules/electron/install.js"],
    {
      stdio: "inherit",
    },
  );
  if (runtime.error) throw runtime.error;
  if (runtime.status !== 0) process.exit(runtime.status ?? 1);
}
const native = spawnSync(process.execPath, ["scripts/build-vault-native.mjs"], {
  stdio: "inherit",
});
if (native.status !== 0) process.exit(native.status ?? 1);
if (!process.argv.includes("--dev")) {
  const notices = spawnSync(
    process.execPath,
    ["scripts/third-party-notices.mjs"],
    {
      stdio: "inherit",
    },
  );
  if (notices.status !== 0) process.exit(notices.status ?? 1);
  const office = spawnSync(process.execPath, ["scripts/office-prepare.mjs"], {
    stdio: "inherit",
  });
  if (office.status !== 0) process.exit(office.status ?? 1);
}
const args = process.argv.includes("--dev") ? [] : ["build"];
const child = spawn(
  process.execPath,
  [
    "--max-old-space-size=4096",
    "node_modules/vite/bin/vite.js",
    ...args,
    "--config",
    "vite.config.ts",
  ],
  { stdio: "inherit", env: { ...process.env, JOCKI_NATIVE: "desktop" } },
);
child.on("exit", (code) => {
  if (code === 0 && args.length)
    code = spawnSync(process.execPath, ["scripts/offline-assets.mjs"], {
      stdio: "inherit",
    }).status;
  process.exit(code ?? 1);
});
