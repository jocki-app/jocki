# Jocki v1 validation

The workspace, companion and file storage layouts are `saddle-workspace/1`,
`saddle-companion/1` and `saddle-file/1`. See
[workspace files](workspace-files.md), [file metadata](file-metadata.md),
[CSDB task files](csdb-task-files.md) and the
[extension SDK](file-extensions.md).

## Storage and synchronization

The automated suite covers durable Save, independent editor drafts, concurrent
merges, restart, binary conflicts, libgit2 move inference, local writer locks,
scoped encrypted sharing, revocation and acknowledged history checkpoints.
Required persistence completes before Save acknowledges success.

History-only, sharing-only and combined features are tested at workspace, vault,
folder and file levels. Checks cover creation/removal of archives, independent
inherited overrides and restart with features on/off. With both features off,
ordinary main files and optional sidecars remain on disk without canonical
Automerge content archives. A device-local recovery journal recovers interrupted pair saves.

Main content and its matching sidecar occupy one protected content document.
Real-peer tests edit both from a recipient, restore both from history, and verify
an unrelated file remains inaccessible. Security regressions cover scope
forgery, identity/path collisions, overlapping routes, edit-to-read downgrades,
disconnect/revocation, revoked-share restart and durable retention barriers.
Disabling features does not erase previously shared protocol copies.

Metadata checks cover generic Data Resources, relative/remote paths, inline data,
Markdown/sidecar conflicts, local diagnostic caching and rechecking, metadata-only
draft events, search indexing, sidecar moves/copies and linked-template restart.
New folders initialize directly as v1 vaults from their ordinary files and
optional sidecars. Workspace JSON validates the complete v1 settings contract.

## Browser, desktop and headless checks

- `tests/browser/vault-metadata.mjs`: optional sidecars, conflict indicators and
  correction, `metadata:` search, graph controls, archive creation/removal,
  template prompts and vault settings, minimal plugin settings, full paths,
  direct toolbars and an in-layout settings pane.
- `file-extensions.mjs`: signed package validation, lazy worker activation,
  isolated editors, draft-only edits, commands, Save hooks and toolbar popovers.
- `vault-regions.mjs`: grouped file views, exact file/view reuse, independent
  task/metadata drafts and merged saves, unified status, navigation and mobile
  layout.
- `task-tree-search.mjs`: native task ID ancestry, recursive materialization,
  sorted root/child/grandchild order, indentation, collapse/restart, keyboard
  search, metadata/path filters and mobile width.
- `history-tasks.mjs`: row save/discard status, held native version descriptions,
  selected bulk saves, private draft isolation, history overview/diff navigation,
  restore drafts, horizontal mobile tables and persisted descriptions after restart.
- `vault-history.test.ts`: native change messages, Unicode character counts,
  row isolation, concurrent edits, queued saves, typing during disk writes and
  failed-write retry.
- `vault-editor-errors.mjs`: exact BigInt SQL, read-only queries, content-type
  validation, component views, tab spacing, Save/Discard/Cancel and workspace
  layout restart.
- `desktop-dev.mjs`: native folder access, draft durability, pop-outs and
  Save/Cancel on Quit. `JOCKI_TEST_PRODUCTION=1` checks the built renderer.
- `tests/workspace-cli.ts`: persistent identity, workspace settings
  export/adoption, stable file IDs, sidecar preservation and plain-file restart.

The task-copy command is checked with native CSDB commands and by reopening the
destination. It verifies every task cell, parent references, other visible
files, task content type and independent identity. The source is read only;
replica caches and OS files are excluded. Runtime vaults are never staged.

```sh
sh scripts/with-node.sh npm test -- --maxWorkers=2
sh scripts/with-node.sh npm run typecheck
sh scripts/with-node.sh npm run sdk:verify
sh scripts/with-node.sh npm run core:verify
sh scripts/with-node.sh npm run ui:verify
sh scripts/with-node.sh npm run build:web
sh scripts/with-node.sh npm run build:desktop
sh scripts/with-node.sh npm run build:peer
sh scripts/with-node.sh npx tsx tests/workspace-cli.ts
```

Set `JOCKI_TEST_URL` to a running development or production preview URL for
browser checks. Native tests compile and exercise the libgit2 helper. UI
verification checks all 28 shared shadcn primitives remain unmodified. Physical
mobile folder-provider interaction and iOS/Android release builds require their
platform environments; browser layout checks do not replace those checks.

## Implementation boundaries

The portable core has no Node, Electron or browser UI imports. Platform file
access uses explicit capabilities. Replicated contents never execute commands or
authorize native access. External plugin packages and publisher trust are local.

External move inference uses only native libgit2. Browser/mobile hosts without its binding do not infer unmatched moves. Binary replacements preserve concurrent alternatives without a semantic
merge. Empty directories persist locally; synchronized files materialize their
parent directories. Automerge Repo/Keyhive/Subduction are pinned prerelease
dependencies.

## Verification on 2026-11-16

The complete suite passed 304 tests across 61 files. Typecheck, SDK/core/UI
verification, native compilation, web, desktop and headless builds passed. The
CLI restart/adoption integration passed. A copied 187-row task vault reopened in
v1 with all task values, 170 parent links, 17 columns and its task content-type
sidecar intact; its other visible files were byte-for-byte preserved.

`tests/companion-storage.test.ts` covers optional packages, libgit2-only moves with edits and same-volume moves, propagation of matcher failures, portable history, folder inheritance and unset, deleted-name reuse, metadata-only discovery of 500 files plus a 32 MiB binary, and path-scoped watcher updates. No inode matcher or alternate content matcher is installed.

## Companion storage verification on 2026-11-17

The suite passed 346 tests across 68 files. Focused watcher/sharing checks passed 31 tests. Typecheck, native libgit2, web, desktop, headless, Android Java and the iOS workspace builds passed. Browser checks passed task save/history/diff, metadata/search/graph/templates, workspace management/deletion and startup failure recovery. The headless CLI restart/adoption check passed.

Filesystem IDs and the portable exact-hash fallback have been removed. Unmatched external moves use the explicit libgit2 capability; engine failures propagate. Structural watcher events take a consistent metadata snapshot before matching, while ordinary edits inspect only changed paths. Empty externally renamed folders cannot be inferred from content. Companion archives are optional, and caches/recovery data stay in application storage.

`tests/companion-roots.test.ts` reopens nested folders with fresh device indexes and a file through a file-only capability. It checks portable identities/checkpoints, metadata, retained history/deletions, explicit overrides and unset, ordinary saves while ancestor features are inactive, restart, and reopening the parent. Real peers verify nested shares retain their URLs/grants, offline renames use libgit2 without being reverted during attachment, outside shares remain inactive, and a root share stays bounded when opened beneath a broader root. Security checks reject changed unit identities and duplicate companion locations and ensure an unknown companion reference never joins a share. No ancestor traversal or boundary policy is added. With these six regressions, the complete suite passed 352 tests across 69 files.

## Independent binary units

The v1 companion is one `.<full-name>.saddle` binary container. `tests/record-container.test.ts` verifies independent named records, concurrent writer serialization, interrupted commits, payload corruption, foreign-format rejection, incremental Automerge saves, bounded record reads and physical archive removal. Root tests cover duplicate named keys, folder-owned declarations, template definitions/source IDs across moves and root changes, portable baselines with empty caches (including after disabling history), and folder archive removal. Sharing tests cover two-way folder/template settings, stable signed unit identities, additive child scopes and protected transport replacement after folder exit. Task history tests verify header saves persist view metadata while unselected rows remain private. Editor tests verify concurrent opens reuse one session; native UI checks exercise file/root binary companions and pop-outs after layout restoration.

Verification: 365 tests across 70 files passed. Typecheck, SDK/core/UI verification, web build, Android debug package and iOS simulator workspace build passed. Browser checks passed metadata/search/graph/templates, independent views and merged saves, task save/history/diff/restart, workspace management/deletion and failed-open startup recovery. Desktop and headless builds and the CLI restart/adoption check passed. Folder move coverage includes named folders with no explicit feature overrides and stable child IDs carried by their companions.
