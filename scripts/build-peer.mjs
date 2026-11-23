import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, chmod } from "node:fs/promises";
const native = spawnSync(process.execPath, ["scripts/build-vault-native.mjs"], {
  stdio: "inherit",
});
if (native.status !== 0) process.exit(native.status ?? 1);
await build({
  entryPoints: ["apps/headless/main.ts"],
  outfile: "dist-peer/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
});
console.log("Built the headless application from the shared peer core.");
await mkdir("dist-peer/native", { recursive: true });
const executable =
  process.platform === "win32"
    ? "Release/jocki-renames.exe"
    : "jocki-renames";
await copyFile(
  "build/native-renames/" + executable,
  "dist-peer/native/jocki-renames" +
    (process.platform === "win32" ? ".exe" : ""),
);
if (process.platform !== "win32")
  await chmod("dist-peer/native/jocki-renames", 0o755);
