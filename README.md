<p align="center">
  <img src="public/jocki_icon.png" width="112" height="112" alt="Jocki logo" />
</p>

<h1 align="center">Jocki</h1>

<p align="center">
  <a href="https://github.com/jocki-app/jocki/actions/workflows/container.yml"><img src="https://github.com/jocki-app/jocki/actions/workflows/container.yml/badge.svg?branch=main" alt="Container build and tests" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL 3.0 license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-26.10%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 26.10 or later" /></a>
  <a href="https://github.com/jocki-app/jocki/pkgs/container/jocki"><img src="https://img.shields.io/badge/container-amd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white" alt="Docker: amd64 and arm64" /></a>
  <a href="docs/distributed.md"><img src="https://img.shields.io/badge/local_first-Automerge-7252D3" alt="Local-first with Automerge" /></a>
</p>

A file-first workspace with multiple folder vaults, ordinary Markdown, CSDB tables, JSON Canvas and arbitrary assets. Files and folders can have optional sibling binary `.saddle` containers for metadata, history and sharing. Frictionless JSON metadata lives in their `resource.json`. History and sharing are independent inherited options for workspaces, vaults, folders and files; enabling either persists Automerge state for the affected content. Plugins share file contracts and core-managed editor drafts. React provides the browser, Electron and Capacitor interface; Keyhive provides protected scoped synchronization.

## Run

Use Node.js 26.10 or later (`nvm install && nvm use`).

```sh
npm ci
npm run dev
npm run build
npm run peer -- --data /path/to/app-data --vault /path/to/Work
npm run electron:dev
```

Open several folders from **Vaults**. They become top-level folders in the file browser. Edit history and sync are independent options. Editors keep changes in their tab until Save, and dirty tabs require Save, Discard or Cancel. The integrated Markdown editor includes links, embeds, graphs and indented editable tables. Generic CSDB, Canvas, code and media viewers work without a specialized content type.

Each opened folder is a workspace reference. Optional sibling `.<name>.saddle` containers hold feature overrides, resource metadata, content archives and share manifests. Application storage holds recovery state and disposable indexes. Desktop/headless use libgit2 alone to infer unmatched file moves from stored content baselines. The workspace uses JSON settings with an optional Automerge archive, defaults and nullable per-computer overrides. See [storage layout](docs/workspace-files.md) and [metadata and scope policies](docs/file-metadata.md). Native apps select real folders; browsers can use OPFS or supported folder access.

Share a workspace, vault, folder or file from **Share**. The owner grants access to each recipient's contact card; an invitation alone grants no access. History-off sync checkpoints wait for durable acknowledgements from required replicas. Browser/desktop choose a sync connection in Share; headless starts offline unless configured. Replicated data never runs commands or authorizes native execution. Desktop stays in the tray until Quit.

Extensions use VS Code-inspired declarations, lazy worker hosts, lifecycle hooks, commands, views and isolated custom editors, through Jocki's own API. Shared MIME/content contracts live in [jocki-content-types](https://github.com/jocki-app/jocki-content-types). See [workspace files](docs/workspace-files.md), [headless setup](docs/self-hosting.md), [extension SDK](docs/file-extensions.md) and the [implementation plan](docs/vault-refactor-plan.md).

## Releases

Run `make release version=dev` for a dated development prerelease, or `make release version=0.4.0` for a stable release. The existing release pipeline publishes desktop, mobile, web and Docker downloads with checksums. The [website](https://jocki.app/#downloads) discovers the newest dev build automatically. See [release instructions and signing limits](docs/releases.md).

## Build and verify

```sh
npm run typecheck
npm test
npm run build:web
npm run build:peer
npm run build:desktop
npm run prepare:ios
npm run prepare:android
```

Native packaging requires the corresponding platform SDK and CMake for desktop/headless libgit2. `tests/browser/file-vaults.mjs`, `tests/browser/file-extensions.mjs` and `tests/browser/desktop-dev.mjs` exercise the current file UI and isolated extensions. Core tests cover durable saves, concurrent merges, rename inference, scoped encrypted sharing, retention checkpoints and restart. Logical commits preserve rollback.
