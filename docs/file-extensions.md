# File extensions

Jocki's `jocki-extensions/1` API uses declarative contributions and lazy
activation. It has no VS Code extension compatibility. See the runnable
[`examples/file-extension`](../examples/file-extension) package and the
[`file-sdk`](../packages/platform/src/file-sdk/index.ts) TypeScript contracts.

## Manifest and activation

`extension.json` declares an ID, publisher, version, license, browser entrypoint,
required nonempty `mimeTypes` (exact types, `text/*`, or `*/*`), optional `contentTypes` names/IDs, and contributions. MIME declarations bound every document capability; selectors can narrow them further. Content-type choices are resolved from the shared catalog when an installed plugin declares them. Contribution IDs and configuration keys use the extension's
namespace. Editors declare MIME/glob/content-type selectors and whether an
explicit content type is required. A matching content-type editor is preferred on first open; all compatible views remain available in the picker.
Untyped files use the built-in Markdown, CSDB, Canvas, media, or code editor.

Reading a manifest never runs its code. Opening an editor, executing a declared
command, opening a contributed view, or requesting completion/search activates
only its provider. Explicit activation events include startup, vault open,
content type, editor, command and view. Registration is disposable. Disabling an
extension aborts its activation generation and removes callbacks and contributions.

## Host and document hooks

Export `activate(context)` and optionally `deactivate()`. Use `context.subscriptions`
for resources the extension creates. Commands run only after explicit invocation;
replicated contents are never interpreted as commands. Document open/change/save/
close, active-editor, configuration and vault-folder events are scoped by declared
selectors. Search/completion providers can read matching content. Editors and
document observers can propose edits only within their declared content contract.
Extension configuration lives in workspace settings, with nullable computer overrides.

The core owns draft versions, Save, Discard and dirty-close decisions. Updates go
to the open draft, never directly to filesystem or sync. A will-save hook returns
text edits, with cancellation and a three-second budget. The core validates edits
and content types, persists the main file, optional sidecar and required recovery/history state, then emits
did-save. A slow hook or concurrent draft change leaves the tab unsaved.

External code runs on a worker thread in an opaque-origin sandboxed host frame with scoped
`vscode-jsonrpc` ports. Browser code must be bundled into one self-contained module.
Hosts have no direct filesystem, origin storage, native bridge, network or parent
DOM access. Native entrypoints are declarations for a separately enabled host;
installing a package or receiving settings never authorizes native execution.

## Custom editors and UI contributions

A custom editor returns `{kind: "webview", html}`. Its separate opaque editor
frame receives `window.jockiEditor` after `jocki-ready`. It can read its
document, subscribe to changes, update version-checked ranges, read declared
settings and invoke its extension's commands. Core Save stays outside the frame.
There is no editor API for writing a file or acknowledging persistence.

Core and plugins use the same `UIContributionRegistry`. Menu locations include
`explorer/context` (vaults, folders and files), `editor/title`, `toolbar`,
`settings`, `workspace/context`, `commandPalette`, `explorer/new-file`,
`explorer/template`, `explorer/template-copy` and `explorer/template-link`.
Templates appear under New file → Template → Copy / Link → template name. Entries can declare
`icon`, `group`, `order` and an inert `when` object with resource `kinds`, MIME,
content type, history and sync conditions. Context is passed to the declared
command when the user invokes it. Showing a menu never activates plugin code.
Core Rename/Delete/Sharing/creation actions use these same locations and
renderers. The `core` namespace is reserved. Uninstalling a plugin removes its
menu entries; menu access does not grant additional document permissions.

For example:

```json
{
  "location": "explorer/context",
  "command": "example.notes.export",
  "icon": "FileText",
  "group": "60.export",
  "order": 10,
  "when": { "kinds": ["file"], "mime": "text/markdown" }
}
```

Commands appear in the palette automatically unless an explicit
`commandPalette` contribution supplies visibility conditions.
Commands may declare keybindings. Sidebar/panel views return a bounded tree whose
click actions must reference declared commands. Settings declare type/default;
completion providers return text candidates; search extractors add searchable
text to the disposable per-vault index. Providers receive cancellation tokens.

Matching optional editors appear as document-tool icons and can be docked as
additional views. Each file/view tab has an independent core draft and isolated frame API.

`contributes.templates` accepts namespaced `id`, `title`, `extension`, optional
`contentType`, and exactly one of initial `text` or a packaged `file`. On first
installation the host asks before copying it to the named templates folder.
Copied files are ordinary vault files, registered in vault settings; their
lifecycle is independent of the plugin. Templates and named paths have one
settings page with a Vault column. Copy-once and linked creation check source
updates only on open; updates remain drafts until Save.

`context.workspace.namedPaths()` lists target unit IDs and their current local mount/path hints. Keys are declared on their target file or folder, and duplicate keys are allowed. `requestNamedPath({ key,
path, kind, title })` asks before adding a mapping; `addNamedPath({ vault, key,
path, kind })` is the direct registration API. Built-ins use prompts.
`requestTemplate({ template, vault })` asks to copy one of that extension's
manifest-declared templates. See [file metadata and scopes](file-metadata.md).
The host no longer adds a user file-glob or a Templates section to every plugin's
settings. A plugin with no configuration contributions has no extra settings.

`context.logger.log(level, message)` and `window.jockiEditor.log(level,
message)` write to the app's local diagnostic sink. Levels are `debug`, `info`,
`warning` and `error`. Messages are limited to 4,000 characters and 120 records
per minute per plugin. Uncaught worker/webview errors use the same scoped bridge.
These calls cannot read logs, use the network or write vault files. Logs never
enter Automerge. See [workspace-navigation.md](workspace-navigation.md).

## Distribution and shared formats

`npm run extension:pack -- --help` packages an extension with `extension.json`,
`LICENSE`, a SHA-256 file index and an Ed25519 publisher signature. Signing keys
stay outside the package. Installation verifies publisher trust and every file
before storing or loading code. Extension inventories use
`jocki-extension-inventory/1`; package trust and installed code are local,
never enabled by replicated settings alone.

Shared content contracts belong in
[jocki-content-types](https://github.com/jocki-app/jocki/tree/main/registries/jocki-content-types).
Declare MIME types and minimal required fields there; use a PR for new types.
Plugin content lives in ordinary vault files rather than plugin-specific database
tables. Settings are the only plugin-owned state in the workspace document.

## Shared UI regions and file views

Core features and plugins use the same declaration paths:

| Region                                                      | Registration                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| File view picker and explorer **Open with**                 | `contributes.editors` with `id`, `title`, `icon`, selectors and priority; resolve through `registerCustomEditorProvider` |
| Document toolbar beside Save/Discard                        | `contributes.menus` at `editor/toolbar`, backed by a declared command                                                    |
| Additional document buttons                                 | `contributes.menus` at `editor/title`                                                                                    |
| Explorer, creation, templates, settings and command palette | The named `MenuLocation` contributions                                                                                   |
| Navigation icons                                            | `contributes.views` with `location: "navigation"`, an `icon`, and a tree provider                                        |
| Sidebar trees and lower panels                              | `contributes.views` at `sidebar` or `panel`                                                                              |
| Unified bottom status bar                                   | `context.window.setStatusBarItem({ id, text, alignment, priority, tooltip, command })`                                   |

The icon button before each file tab title lists compatible views grouped by
plugin. Choosing a view changes that tab. Explorer **Open with → plugin → view**
opens or focuses the existing file/view tab. A normal file click focuses its
first open tab. Tabs stay in their split panes. Core Markdown, Tasks, CSDB tables,
columns, SQL, metadata, history and sharing use the same editor registrations.

Different file/view tabs have independent drafts, Save and Discard. Their
`ExtensionDocument.instance` identifies the draft. Pass it as the optional fourth
argument to `workspace.updateDocument(vault, id, edits, instance)` when targeting
a particular document snapshot; omitting it targets the matching active draft.
Webview document updates are bound to their own draft and version. Explicit saves
merge through FileVault; opening another view does not publish unsaved changes.

Status items default to the right; higher priority places them nearer that edge.
Dispose an item when no longer relevant. Status changes update the status region
without invalidating editor contributions. Core supplies MIME/content-type and
save status, Tasks supplies the total task count, and Word count supplies words
and characters. Change a file's content type in the **Properties** view.

The top bar holds only navigation and settings toggles. Full vault-relative paths, including the file extension and contextual menus, live
below the file tab, the vault menu is at the navigation pane's bottom, and Files,
Search and Graph are registered navigation choices. Built-in task filters use the
same document toolbar region as contributed commands.

The document bar has the path on the left and visible contributed actions on the
right. Both sides scroll, sharing space equally when both need it and donating
unused width otherwise. `editor/title` and `editor/toolbar` commands appear
directly; a command contributed to both appears once. A menu can declare
`popover: { title, items: [{ command, title, icon }] }` for a toolbar popover. Every
referenced command must be declared by the same extension. The right settings
pane participates in the layout and does not cover the file.
