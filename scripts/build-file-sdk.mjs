import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("packages/platform/assets/file-sdk", { recursive: true });
await build({
  entryPoints: ["packages/platform/src/file-sdk/browser-client.ts"],
  outfile: "packages/platform/assets/file-sdk/browser-client.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
});
await build({
  entryPoints: ["packages/platform/src/file-sdk/browser-extension-host.ts"],
  outfile: "packages/platform/assets/file-sdk/browser-extension-host.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
});
