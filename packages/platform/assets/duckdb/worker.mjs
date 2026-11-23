// DuckDB-Wasm's Node extension loader otherwise downloads into the user's home.
// Serve only the bundled, signed JSON module. Workspace data never uses this path.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
globalThis.XMLHttpRequest = class BundledExtensionRequest {
  open(method, url) {
    if (
      method !== "GET" ||
      url !==
        "https://jocki.invalid/duckdb/v1.5.6/wasm_eh/json.duckdb_extension.wasm"
    )
      throw Error("DuckDB external access is disabled");
  }
  send() {
    const bytes = readFileSync(
      require.resolve("@jocki/platform/duckdb/json"),
    );
    this.response = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    this.status = 200;
  }
};
await import("@duckdb/duckdb-wasm/dist/duckdb-node-eh.worker.cjs");
