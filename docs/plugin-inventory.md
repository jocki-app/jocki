# Plugin inventory

Optional plugins use independent packages. Devices consume the [reviewed inventory](https://github.com/jocki-app/jocki/blob/main/registries/plugins.json); every published entry names an HTTPS download URL, checksum, publisher and permissions. The initial inventory is empty. Any HTTPS host can distribute a signed archive.

The current distributed [plugin specification](plugins/README.md) lives in this repository alongside `packages/platform`, the authoritative SDK. The inventory repository's original specification describes the v1 compatibility contract. New plugins should supply a portable `entrypoints.core` module and opt into platform capabilities explicitly.

In **Plugins**, search names and descriptions, click an info icon for package details and permissions, and use the action icons to install, enable, disable or uninstall. Available updates appear in the package info popup. Install starts immediately and installs dependencies; there is no confirmation dialog. Required core providers use the same columns but their disable and uninstall controls remain unavailable.

**Sync** refreshes the list. Its connected gear button opens **Plugin sources**, where you can add or remove up to 20 inventory URLs. **Save and sync** validates and fetches all sources before saving the list for this workspace on this device. Sources and publisher trust are not replicated to other computers. The initial source is the public inventory, or build-time `VITE_PLUGIN_INVENTORY_URL`. Native execution peers configure their own `PLUGIN_INVENTORY_URL`.

Sources are merged by plugin ID. The newest numeric `major.minor.patch` version wins; identical releases appear once, using the first source's download location. Conflicting publisher keys, different publishers for one plugin ID, or different checksums for the same version reject the refresh. If any source fails, the previous saved sources and catalog remain intact. Source and artifact URLs must use HTTPS, without embedded credentials or fragments. Local development builds can use HTTP. Browser-accessible hosts must allow CORS.

Installs verify signatures and checksums and retain downloaded code locally for offline use. A workspace replicates plugin selections without requiring every device to execute native code. Configure each execution computer independently. The Plugins page's Import button installs the portable/browser part on this device; native execution remains subject to that computer's locally enabled capabilities and package installation.

Native packages are stored under `<data>/plugins`; browser packages are in the device's local cache. Container updates preserve the `/data` volume. Use an item’s **Execution settings** to install reviewed dependencies on its selected online computer. Enable remote installation locally in Devices. See [per-item execution](plugins/execution.md) for status, grants and signed handoff.

Native plugin code is trusted in-process code. Back up the entire native data directory, including plugin packages, local workflow checkpoints and projections. Workspace files retain shared data while keeping installation identities separate; reinstall reviewed UI packages on a new device.

## Inventory JSON

Every configured URL returns a UTF-8 JSON object with this structure. `publishers` maps publisher IDs to Ed25519 public keys in PEM/SPKI format. Adding a source authorizes its publisher keys for package verification; private signing keys never belong in an inventory or ZIP.

```json
{
  "schemaVersion": 1,
  "name": "Example plugins",
  "publishers": {
    "example": "-----BEGIN PUBLIC KEY-----\n...base64 SPKI...\n-----END PUBLIC KEY-----"
  },
  "plugins": [
    {
      "id": "example.notes",
      "name": "Example Notes",
      "description": "Workspace notes.",
      "version": "1.0.0",
      "publisher": "example",
      "license": "MIT",
      "downloadUrl": "https://example.com/example-notes-1.0.0.zip",
      "sha256": "<64 lowercase hexadecimal characters: SHA-256 of the entire ZIP>",
      "permissions": [],
      "dependencies": [],
      "grants": ["core.settings"],
      "platforms": ["browser", "desktop", "ios", "android"]
    }
  ]
}
```

`permissions`, `dependencies`, name, description, version, publisher and license must match `plugin.json`. `grants` contains the union of manifest permissions, all shared service IDs, consumed commands and consumed events, with duplicates removed. Optional `repositoryUrl`, `homepageUrl`, `documentationUrl` and `tags` are supported. An inventory can have no plugins and supply only publisher keys for local imports. Each inventory and the merged result support at most 500 plugins; inventory downloads are limited to 2 MiB. Unknown JSON properties are rejected.

## Local import ZIP format

**Import** opens a file picker and installs one `.zip` immediately. The package does not need its own inventory entry, but its publisher's public key must already be present in the configured, successfully synced source lists (the cached catalog also works offline). Unknown publishers and unsigned ZIPs are rejected; a key embedded in its own package is not trusted automatically.

Files must be at the ZIP root, with no enclosing folder:

```text
plugin.json             Manifest conforming to the plugin SDK
schemas.json            Array of collection contracts; [] when there are none
LICENSE                 Package license text
core.mjs                When declared as entrypoints.core
browser.mjs             When declared as entrypoints.browser
server.mjs              When declared as entrypoints.server
package-index.json      Signed file inventory described below
package-signature       Base64 Ed25519 signature of the exact index bytes
```

Use the [plugin specification](plugins/README.md) for the complete manifest and entrypoint contracts. Bundle module dependencies using `@jocki/platform/build-plugin`; the ZIP contains built modules, not a source checkout or `node_modules`. Every declared entrypoint and indexed file must exist. Additional assets and third-party notices are allowed when indexed. Paths are relative, cannot contain `..` or backslashes, and cannot be absolute or symlinks. The archive and total indexed expanded contents are each limited to 50 MiB, with at most 1,000 indexed files. Signature metadata is limited to 256 KiB for the index and 1 KiB for the signature.

`package-index.json` is UTF-8 JSON:

```json
{
  "format": 1,
  "publisher": "example",
  "files": {
    "plugin.json": { "sha256": "<file SHA-256>", "size": 1234 },
    "schemas.json": { "sha256": "<file SHA-256>", "size": 2 },
    "LICENSE": { "sha256": "<file SHA-256>", "size": 1070 },
    "core.mjs": { "sha256": "<file SHA-256>", "size": 987 }
  }
}
```

Sizes are uncompressed byte counts; hashes are lowercase SHA-256 hexadecimal. The index lists every regular file except `package-index.json` and `package-signature`. Those two reserved files are not indexed, and `artifact.zip` is forbidden. Sign the exact serialized index bytes without reformatting them afterward. The index publisher must match the manifest publisher.

From the app repository, create a compatible signed package with:

```sh
npm run plugin:pack -- /path/to/plugin/dist /private/path/publisher-private.pem /path/to/releases/example-notes-1.0.0.zip
```

Keep the key and output ZIP outside the built package directory. The command refuses to overwrite an existing output file. Local imports verify signatures, paths, sizes, file hashes and SDK contracts before storing or running code. Dependencies must be installed already or available from the configured lists. A failed dependency installation is reported; the verified package remains cached for retry. Changing an already imported version requires a new version number, and imports cannot downgrade a cached package. Imported modules and contracts are saved together in a local transaction before installation is acknowledged.
