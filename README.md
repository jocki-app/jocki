# Jocki

A local-first workspace for notes, tasks, structured data and personal productivity. Work with ordinary files, keep editor drafts private until Save, and enable metadata, history or approved sharing only where you need them.

- Markdown editing, backlinks, graph views, metadata search and reusable templates.
- Tasks with nested subtasks, typed CSDB tables, attribute forms, native enum/array fields and configurable imports.
- Independent tabs, split panes, plugin commands, toolbar contributions and a unified status bar.
- Browser, Electron desktop, Capacitor mobile and a headless Node runtime.
- Portable SADDLE sidecars for file/folder metadata, retained versions and authorized synchronization.

## Development

Use Node.js 26.10 or newer. `nvm install && nvm use` selects the version in `.nvmrc`.

```sh
npm ci
npm run dev
make run-dev
npm run typecheck
npm test
npm run build
```

`npm run build:web`, `npm run build:desktop` and `npm run build:peer` verify the main runtime targets. Mobile builds use the checked-in native projects and Capacitor commands in the Makefile. Native folder access and content-based rename matching use explicit filesystem capabilities and libgit2. Desktop commands install the pinned Electron runtime on first use; web and headless installs do not need that download. Production UI builds allow a 4 GiB compiler heap, so provide at least 6 GiB of system memory when building.

## Storage and synchronization

Files remain in their own formats. An optional `.<full-name>.saddle` sibling holds named records for a file or folder. History and sharing have independent inherited policies, with explicit overrides and boundaries at the opened root. Content and resource metadata share one unit history. Signed peer agreement protects pruning; disconnected devices retain saved copies when future access is removed. Received data never executes application commands.

Jocki uses the independent [`@jocki/saddle` TypeScript SDK](https://github.com/jocki-app/saddle-typescript-sdk). A reproducible package snapshot lives in `vendor/`, so a checkout builds without another repository. Core storage modules are thin public SDK re-exports. The [SADDLE specification](https://github.com/jocki-app/saddle-specification), [Python SDK](https://github.com/jocki-app/saddle-python-sdk), [CLI](https://github.com/jocki-app/saddle-cli) and [documentation site](https://jocki-app.github.io/saddle-website/) are maintained separately.

Read [workspace storage](docs/workspace-files.md), [metadata](docs/file-metadata.md), [extension APIs](docs/file-extensions.md), [CSDB forms and templates](docs/csdb-task-files.md), and [release builds](docs/releases.md). Content contracts are in [`registries/jocki-content-types`](registries/jocki-content-types).

## Website and license

The product website is [jocki.app](https://jocki.app), maintained in [jocki-app/website](https://github.com/jocki-app/website).

Licensed under **GPL-3.0-only**. See [LICENSE](LICENSE). Bundled third-party components retain their own notices.
