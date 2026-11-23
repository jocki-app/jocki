import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve("packages") } },
  test: {
    // Atomic publishes extensionless ESM imports intended for a bundler.
    server: { deps: { inline: ["@atomic-editor/editor"] } },
    setupFiles: ["tests/fixtures/setup.ts"],
    environment: "node",
    // Each integration worker can own native/Wasm databases and sync peers.
    maxWorkers: 4,
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 20000,
  },
});
