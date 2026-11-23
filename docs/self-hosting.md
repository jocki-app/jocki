# Headless file workspace

Use Node.js 26.10 or later and CMake 3.24 or later. Build with `npm ci && npm run build`.

```sh
node dist-peer/main.js --data /path/to/app-data --vault /path/to/Work --vault /path/to/Personal --no-ui
```

App data and vaults must be separate directories. The runtime owns one local writer per vault, watches ordinary file saves through Chokidar, and uses libgit2 to infer moves from content. An occasional full scan catches missed filesystem events. Every file has its own Automerge document. History and sync are independent vault settings.

## Connections and invitations

The runtime is a Keyhive/Automerge client. It starts offline unless a local relay configuration is supplied:

```json
{ "endpoints": ["wss://keyhive.sync.automerge.org"], "syncServer": "keyhive" }
```

Pass `--sync-config /private/sync.json` or `JOCKI_SYNC_CONFIG`. Custom compatible relays can supply `syncServer: {contactCardJson, peerId}`. The browser and desktop **Share** dialog selects the same connection. An invitation identifies a protected share; the owner must separately grant this replica access to its public contact card.

Stop a runtime before management commands against its app data:

```sh
node dist-peer/main.js --data /path/to/app-data --contact-card --output /private/contact.json
node dist-peer/main.js --data /path/to/app-data --sync-config /private/sync.json --join /private/sync-link.txt --destination /path/to/empty-vault
```

Create a scoped share and grant a recipient:

```sh
node dist-peer/main.js --data /path/to/app-data --share file --vault-id VAULT_ID --path notes.md --grant /private/contact.json --access edit --output /private/sync-link.txt
```

Scopes are `file`, `folder`, `vault`, and `workspace`. Workspace shares carry settings and child vault invitations. Join each desired child into an empty local folder. Granting the workspace group also covers future files created in those shared vaults. File and folder shares do not disclose unrelated vault contents.

## Storage and HTTP

`--export-workspace <file>` exports the single workspace settings document. `--import-workspace <file>` adopts settings while preserving this machine's local mounts. File content remains in vaults; the export is not a vault backup. Back up ordinary files and their sibling binary `.<name>.saddle` containers (including the opened root’s sibling), plus the stopped app-data directory if preserving this device's signing identity.

The optional HTTP endpoint serves the static app and `/api/health`, on `127.0.0.1:8080` by default. Set `--host`, `--port`, and `--no-ui`. Web clients own independent browser replicas and explicitly join granted shares; HTTP does not expose server filesystem or command APIs. Serve remote clients behind HTTPS with COOP `same-origin` and COEP `require-corp`.

Replicated data does not install code, enable native execution, or run commands. The file extension API is described in [file-extensions.md](file-extensions.md).

## Container

```sh
cp .env.example .env.peer
docker compose --env-file .env.peer up -d --build
```

Compose persists app data at `/data`. Mount vault folders separately and set `JOCKI_VAULTS` to a JSON array of container paths, for example `["/vaults/Work"]`. Mount a custom relay configuration separately. Set `JOCKI_SERVE_UI=1` to serve the app.

Supported environment variables: `JOCKI_DATA`, `JOCKI_NAME`, `JOCKI_VAULTS`, `JOCKI_SYNC_CONFIG`, `JOCKI_SYNC_INTERVAL_MS` (fallback scan interval), `JOCKI_SERVE_UI`, `JOCKI_HOST`, `PORT`, and `JOCKI_UI_PATH`. Keep device identities, runtime directories, and invitations out of source control.

Sharing commands emit one-line `saddle://share/…` links. Grant and Join read that same link format; raw JSON invitations are not accepted. Links carry the workspace/vault/folder/file kind and name for preview; admission verifies the signed scope contract.
