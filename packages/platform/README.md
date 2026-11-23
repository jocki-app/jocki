# Jocki platform SDK

The SDK source is maintained in the main Jocki repository. Build it with `npm run sdk:build` from the repository root. Feature plugins remain separate packages.

Read the [distributed plugin specification](../../docs/plugins/README.md) for mandatory PostgreSQL field contracts, shared UI/storage, JSON-RPC and CloudEvents messaging, declared capabilities, credential use, signing and inventory metadata. Portable modules use `entrypoints.core`; browser surfaces and native services are optional adapters.

SDK 0.4 removes the retired central-server device host exports. Native terminal and automation execution now belong to the app's device adapters. The v1 record/UI and native plugin compatibility contracts remain supported.

Shared documents use Automerge Repo with official IndexedDB and filesystem adapters. Declare `core.documents` to obtain the native Repo and individual item handles via `open(schemaId, kind, id, initial?)`; await `flush()` before reporting a saved write. Each plugin defines its item kinds and contents. Core links items through plugin/schema, schema and workspace index documents. `core.settings` stores shared plugin preferences; `core.settings.computer` stores private per-computer preferences in a separate document. See the [document API](../../docs/plugins/README.md#native-automerge-documents). DuckDB-Wasm and native DuckDB provide local SQL projections. Field descriptors retain the shared `pgType` vocabulary and map to typed SQL columns; see the [DuckDB mapping](../../docs/plugins/fields.md). Declare `storage.local.mode: "core"` and use core collection/file services. React subscriptions are exported as `@jocki/ui/storage`. The `dexie` manifest spelling remains an API alias for already published packages; previous databases are not read or migrated.

The SDK package includes the pinned, official DuckDB JSON Wasm extension and a restricted Node worker loader under `assets/duckdb`. These are runtime assets: preserve them when packaging the desktop/headless application. See [asset provenance and update instructions](assets/duckdb/README.md).
