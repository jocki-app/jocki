import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { defineConfig } from "vite";
import { officeAssets } from "./scripts/office-assets";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
export default defineConfig(() => {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "X-Content-Type-Options": "nosniff",
  };
  return {
    base: "./",
    plugins: [
      react(),
      tailwindcss(),
      officeAssets(),
      ...(process.env.JOCKI_NATIVE === "desktop"
        ? [
            electron({
              main: {
                entry: "electron/main.ts",
                vite: {
                  build: {
                    rollupOptions: {
                      external: [
                        "fs-native-extensions",
                        "node-pty",
                        "openworkflow",
                        "openworkflow/sqlite",
                        "typescript",
                        "web-worker",
                        /^@duckdb\//,
                        /^@automerge\//,
                      ],
                    },
                  },
                },
              },
              preload: { input: "electron/preload.ts" },
            }),
          ]
        : []),
    ],
    resolve: {
      dedupe: ["@automerge/automerge"],
      alias: [
        { find: "@", replacement: path.resolve("packages") },
        {
          find: /^@automerge\/automerge(?:\/slim)?$/,
          replacement: require.resolve("@automerge/automerge/slim"),
        },
        {
          find: "cloudevents",
          replacement: path.resolve(
            "node_modules/cloudevents/bundles/cloudevents.js",
          ),
        },
      ],
    },
    optimizeDeps: {
      include: ["@automerge/automerge", "@automerge/automerge/slim"],
      // Repo needs prebundling for CommonJS dependencies such as debug.
      // Subduction's Wasm entry uses top-level await and stays native ESM.
      exclude: ["@automerge/automerge-subduction"],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      headers,
      watch: {
        ignored: [
          "**/release/**",
          "**/build/native-renames/**",
          "**/ios/**",
          "**/android/**",
          "**/tests/**",
          "**/dist-peer/**",
          "**/dist-electron/**",
        ],
      },
    },
    preview: { host: "127.0.0.1", port: 4173, headers },
    build: {
      target: "esnext",
      outDir: "dist",
      sourcemap: true,
      manifest: true,
    },
  };
});
