# Bundled DuckDB JSON extension

`json.duckdb_extension.wasm` is the unmodified official DuckDB 1.5.6 extension for `wasm_eh`.

- Source: https://extensions.duckdb.org/v1.5.6/wasm_eh/json.duckdb_extension.wasm
- SHA-256: `2f100ca7d08598ad084405ab1bab7691fd1f30d0d50cc492534042c45205bada`
- License: MIT (DuckDB; see the adjacent LICENSE file).
- Engine: `@duckdb/duckdb-wasm` **1.33.1-dev65.0**, pinned to the matching engine and fixed OPFS implementation.

The web build serves this asset locally and includes it in offline caching. The Node Wasm worker serves this same asset through a restricted local extension loader, without network requests or writes to the user's home directory. Automatic installation/loading and external SQL filesystem access are disabled after loading the bundled extension. Never enable unsigned extensions.

Update the engine, extension, checksum, generated empty database, and file round-trip tests together. `scripts/duckdb-seed.mjs` generates a pristine database with the matching official native engine; it contains no application data.
