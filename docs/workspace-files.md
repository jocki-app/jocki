# Workspace files and companions

A workspace is portable `saddle-workspace/1` JSON. Its vault entries are references to top-level folders, with display names in `defaults.rootNames` and device-local location tokens. A vault is a mounted folder reference, not a storage container. Shared defaults and nullable per-computer overrides live in the workspace. Receiving settings cannot grant filesystem access.

The app starts on Create / Join / Manage with no workspace loaded. Closing a workspace or failing to open a folder returns there after releasing the session. Only the workspace reference list is remembered as launch navigation; there is no saved active selection. Storage errors appear through local logging and notifications. See [workspace navigation](workspace-navigation.md).

Internal workspace JSON lives in application storage. Folder workspaces keep JSON at the selected location. Desktop dialogs address a JSON file directly; browsers with a directory picker use `workspace.json` within the selected folder. Its optional Automerge archive exists only while workspace history or sharing is enabled.

Files and folders use the same optional sibling **file** naming rule: `.<full-name>.saddle`.

```text
Work/
  notes.md
  .notes.md.jocki         # one binary container
  Projects/
    tasks.csdb
    .tasks.csdb.jocki
  .Projects.jocki         # Projects' own declarations, history and shares
.Work.jocki               # exists only when Work itself needs a feature
```

A v1 container begins with `SADDLE01`. Its named records are:

| Record | Purpose |
| --- | --- |
| `descriptor.json` | Stable unit ID, kind, explicit feature overrides, portable save checkpoint and pending retention references |
| `resource.json` | Optional UTF-8 Frictionless Data Resource |
| `content.automerge` | File content and resource metadata in one Automerge history |
| `folder.automerge` | Folder declarations, metadata and direct membership; no child file bytes |
| `shares/<id>.automerge` | That unit's independently authorized share manifest |
| `membership.json` | Direct child IDs/names as advisory move hints; no child contents |
| `baseline.bin` | Last observed ordinary bytes for rename recovery when no content archive exists |
| Other names | Preserved extension-owned records |

These are record names, not filesystem paths. The descriptor uses `saddle-companion/1`; content and folder documents use `saddle-file/1` and `saddle-folder/1`. Ordinary files and folders need no companion. Only metadata, declarations, explicit overrides or enabled history/sharing create one. Opening a folder, using search or adding a feature to a child does not create the parent's companion.

The container has two checksummed commit slots, immutable record chunks and a bounded JSON index. Record reads verify SHA-256 checksums. Positioned writes flush appended data and index before publishing the next slot. An interrupted publication leaves the previous slot readable. Automerge records append `saveSince` changes; unchanged heads write nothing. Removing an archive compacts the container to discard its bytes. Replacements and bounded waste also compact atomically. Node, Electron, iOS and browser files expose positioned I/O; Android document providers use durable replacement and bounded range reads. Unknown records survive edits and compaction. Only this binary v1 layout is accepted.

A stable ID belongs to the unit, independently of a mount or workspace. A recognized rename moves its container and preserves its ID. Folder-owned membership hints also reconnect orphan companions when stable child IDs travel with a moved subtree. Conflicting hints remain unmatched; hints never grant access or traverse ancestors. Deleted files retained after deleting a containing folder become independently discoverable sibling `.deleted-<id>.saddle` containers with a relative deleted-path hint; no root tombstone registry is required. Reusing a filename creates a new identity.

Named keys live on their target folder's descriptor or the target file's resource metadata. A template file stores its own name/enabled declaration in resource metadata. Duplicate keys are permitted; template installation asks for a destination when several folders declare `templates`. Linked templates store a stable source file ID and advisory location hint, never a mount ID. Collection-view preferences live in the file's resource metadata and follow the normal draft/Save pipeline.

The opened folder's companion is its sibling, outside the folder capability. Native desktop access is limited to that one sibling. Browser/mobile hosts request access to the direct parent when needed. Reading an ordinary folder does not create its companion or prompt for parent access. Traversal and symlink escapes are rejected.

Editors keep private drafts until Save. With history and sharing off, ordinary files and optional resource metadata are canonical; no content Automerge archive is retained once pending peer agreement and distinct current data conflicts are resolved. Save uses a durable device-local recovery journal, materializes the file/resource pair, writes its checkpoint and removes the journal before acknowledging success. With either feature enabled, one Automerge document contains both main content and resource metadata. Markdown uses collaborative text, CSDB uses structured tables/rows/cells and a text projection, and binary replacements preserve conflicting values.

History and sharing inherit independently from workspace through the opened root, ancestor folders and file overrides. An absent property inherits; explicit `false` disables it. Clearing an override resumes inheritance, including for future child files. Turning both features off removes affected content archives without deleting ordinary files or metadata once no peer agreement is pending. With no shares, cleanup is immediate. Active sharing without history keeps only the current checkpoint after pruning. Shared file and folder histories wait for durable signed acknowledgements from all participating computers, including offline computers; the old protected transport is then deleted on each computer. Pending retention references stay with the unit through renames and changes of the opened boundary. Unset itself requires no companion and never persists a false override.

The selected filesystem capability naturally limits discovery: opening `Work/Projects` reads `.Projects.saddle` and companions inside `Projects`, without reading `.Work.saddle` or other ancestors. No boundary setting is stored. Unshared archives inside the new boundary are cleaned when history no longer inherits; ancestors outside it are not modified. A file-only capability likewise exposes just that file and its companion. File identity, metadata and history travel with the companion; portable checkpoints use the filename and package-relative resource path rather than the original mounted root. Retained deletion hints are relative to their container location.

Opening a narrower root does not disable features outside it or delete their archives. Inside the selected boundary, effective history controls retention; an inactive, unshared archive is not kept for a previously opened ancestor. Sharing resumes only for companions discovered within the selected capability and only when the device already holds the matching unit identity, signed scope contract and access grant. Local transport paths are rebound to the selected root; signed grants remain unchanged. Opening a parent later cannot expand a child's share to include its siblings.

Application storage holds `state/roots/<location-hash>/root-index.json`, per-file materialization checkpoints, binary baselines, pending-write/move recovery journals, metadata diagnostics and search caches. None are placed in content folders or shared. The root index uses `saddle-root-index/1` and can be rebuilt from ordinary files and companions; it is not a portable vault manifest. Device signing keys and encrypted protocol caches remain separate app data. Copying a companion never authorizes a device.

Filesystem events carry changed paths and are batched before reconciliation. Metadata inventories skip Git internals and treat companions as opaque files. Unchanged stamps avoid content reads; opening a file loads its document lazily. Search indexes only changed content and limits extraction to files up to 8 MiB, while larger files remain discoverable by path and resource metadata.

External rename inference uses **libgit2 only**, on unmatched missing/new files with observed baselines. Same-path replacement saves are edits. Filesystem IDs are not stored or used for rename matching, and no alternate matcher runs after an error. The native matcher uses a 70% similarity threshold, bounded candidate comparisons, and rejects ambiguous identical content. Its helper currently accepts up to 256 MiB per candidate. A metadata-only companion carries its observed baseline, so a fresh device cache can still recognize a move with edits. A file with neither a companion nor a device baseline has no portable identity to recover. Browser/mobile hosts without a libgit2 binding treat unmatched external moves as deletion/addition. Empty folders have no content for inference. Moves performed through Jocki explicitly move the file/folder and companion together, including empty folders.

Git itself uses its own implementation: hash matches and likely-name candidates reduce the work before bounded similarity comparisons. See [Git's rename documentation](https://git-scm.com/docs/gitdiffcore) and [libgit2's matching options](https://libgit2.org/docs/reference/main/diff/git_diff_find_options.html).
