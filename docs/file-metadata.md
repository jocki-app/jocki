# File metadata, templates and optional history

`resource.json` is an optional UTF-8 JSON [Frictionless Data Resource](https://datapackage.org/standard/data-resource/) record in `.notes.md.saddle` beside `notes.md`. The complete filename is retained, so `.notes.pdf.saddle` is independent. Sidecars are part of their main file and do not appear as independent files in the explorer, search or shares.

```json
{
  "$schema": "https://datapackage.org/profiles/2.0/dataresource.json",
  "name": "notes",
  "path": "notes.md",
  "metadata": { "project": "Tide", "owner": "Lindiwe" },
  "jocki": { "contentType": "example.note" }
}
```

`name` and exactly one of `path` or `data` are required. Paths can be relative siblings/children, HTTP(S) URLs, or homogeneous arrays of either. Parent traversal and absolute filesystem paths are invalid. Inline JSON objects/arrays and text with `format` or `mediatype` are supported. Standard and custom descriptor properties are preserved. The app treats paths as graph links; it does not fetch remote resources or execute their contents. Its default descriptor points to the adjacent main file.

The application content type lives exclusively in `jocki.contentType`. File documents have no separate content-type field. Setting a content type in Properties creates a sidecar if necessary. Linked-template references also live under `jocki.template` so they survive ordinary-file restarts. Properties can edit the entire descriptor, including its custom `metadata` object.

Markdown YAML frontmatter is converted to JSON and enters the same metadata pipeline. Descriptor properties, its `metadata` members, and frontmatter properties must have distinct keys. Any overlap, invalid JSON/YAML, or invalid descriptor rejects the entire metadata import, including content-type selection. The file contents remain available. An error button beside the file shows the diagnostic and rechecks it; the context menu also offers Clear metadata error and recheck. The cache is local at `state/roots/<location-hash>/metadata-errors.json` in application storage and is never shared. A successful save or recheck clears the error.

Search supports `metadata:owner`, `metadata:Tide`, ordinary full-text metadata terms, and the existing `path:`, `mime:`, `type:` and `vault:` filters. `tag:` has been removed. Graph has independent Links, Metadata and Folder hierarchy toggles. Links include Markdown links and resource paths; metadata nodes include property names/values and Markdown hashtags. The default resource self-link is omitted from the graph.

## Persistence and scopes

History and sharing are independent, inherited features at workspace, vault, folder and file levels. The nearest explicit override wins separately for each feature. New workspaces default both off. Context menus, document toolbars and workspace/vault controls expose one History action and one Sharing action. When off, they read Enable history or Enable sharing; clicking durably enables the selected feature at that scope, then opens its popup. When on, History and Sharing open the popup without changing policy. Each popup contains its own disable action.

When both features are off, the canonical data are ordinary files and their optional sidecars. No content Automerge archive is persisted. Draft merging can still use transient in-memory CRDT state. Save durably journals the pair in device-local recovery storage, writes the ordinary file, resource record and local checkpoint, then removes the journal before acknowledging success. Opening after an interrupted save finishes that pending write.

Enabling either feature creates protected content storage for affected files. Main content and its sidecar occupy **one** Automerge document, so sharing and history restore include both. Turning both off removes those local content archives while retaining ordinary files. Workspace settings live in workspace JSON. Folder overrides live in that folder’s sibling `.<folder>.saddle` descriptor record; file overrides live in `.<file>.saddle` descriptor record. An absent flag inherits. Clearing an override restores inheritance. Share manifests are named `shares/<id>.automerge` records in the relevant binary container; authorization remains device-local.

Sharing continues to use authenticated, scoped transports. A file share includes its sidecar but grants no access to unrelated files. Disabling sharing prevents future publication through that scope; copies already received by another device remain there. Clearing retained history on a shared file uses the existing durable acknowledgement barrier. Local diagnostic/search/materialization caches are excluded from sharing.

Feature toggles remove canonical content archives. They do not erase previously shared copies from encrypted protocol caches or other replicas.

Opening a nested folder limits inheritance to the companions visible from that selection. It does not act as a feature toggle: archives belonging to an enclosing history policy are preserved while inactive. Ordinary edits made there are reconciled when the enclosing folder is reopened. Inside shares keep their existing grants and file identities across root changes. Companion references alone cannot join a share or grant access. See [root-independent storage](workspace-files.md).

Jocki v1 uses `saddle-workspace/1`, `saddle-companion/1` and `saddle-file/1`. Folders initialize from ordinary files and optional companions. There is no central vault metadata tree. Application caches and recovery state live outside content folders. See [the storage layout](workspace-files.md).

## Named paths and templates

Each named target stores its own keys. Folders declare `namedKeys` in their own descriptor; files use `jocki.namedKeys` in resource metadata. Each template file declares `jocki.templateDefinition: {name, enabled}` in its own resource. Multiple folders may use the same key, with an explicit destination choice when copying templates. The opened root holds no descendant registry. The first vault added to a workspace prompts for `templates:/templates`; the user may skip it. Built-in and installed plugins can prompt to copy packaged template files there. Copied files belong to the vault and retain no plugin ownership. Settings → Templates and named paths lists the vault for each row, including enable/unregister controls. A file context menu can designate any existing file as a template.

New file → Template → Copy / Link offers enabled templates. Copy makes an independent file. Link records the source stable file ID and advisory path hint and checks for updates when opened; proposed updates remain drafts until Save. Plugins can use `workspace.namedPaths`, `requestNamedPath`, `addNamedPath` and `requestTemplate`; built-ins use the prompt APIs.

Folder history records its own declarations and direct membership. Child histories remain in their own containers and are listed by the scope history UI. Parent shares cover descendants; child shares add independent grants. Every shared document includes its retained history. No audience-exclusion or private-history mode is provided.
