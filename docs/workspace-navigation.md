# Workspace navigation, contributions and diagnostics

The app launches on **Create / Join / Manage** with no workspace loaded.
Browsing these pages reads the saved-workspace catalog and local diagnostics;
there is no active selection, automatic reopen or Continue action.

Create offers **Folder / Internal** workspace storage. Internal workspaces use a
name and live in app storage. Desktop Folder workspaces use a Save dialog for a
JSON file; supported browsers select a folder containing `workspace.json`.
Their optional archive stays beside the JSON (`<selected-file>.automerge` on
desktop, `workspace.automerge` in browser folders). Both also offer an initial
vault choice: **None / Folder / Internal**. Folder choices display the granted
path; Internal choices ask for a name. Unsupported options are hidden, and a
single supported choice is shown as text instead of a toggle. Mobile currently
supports internal workspaces and both native-folder/internal vaults.

Join accepts a one-line `saddle://share/…` sync link. Its embedded kind selects
the form; Inspect verifies access and the signed share contract before importing.
Workspace shares use the workspace creation form and destination choices for
each shared vault. Vault shares choose a Folder or Internal destination. File
and folder shares offer a new vault (inside a new internal workspace) or a
stored vault reference, which opens its owning workspace. None skips a shared
vault when joining a workspace. Joining explicitly enables Broadcast, preserves
per-scope authorization and never grants filesystem access from remote settings.

Manage lists saved workspaces by internal name or external JSON path. Desktop
can open a selected JSON file; supported browsers open `workspace.json` from a
selected folder. A brush removes only an external reference. An internal
workspace cannot be orphaned by unlinking: removing it deletes its JSON.
Trash opens an exact-name confirmation with a table of the workspace and its
vaults. Workspace deletion removes its JSON and optional archive; each selected
vault removes only its binary `.saddle` containers. Ordinary files remain. Metadata, history and share manifests in selected companions are removed. Selected vault references are removed from a
retained workspace. Unselected vaults remain, including those referenced by
other workspaces. Missing files are errors on Open; they are never silently
recreated. Mutations use the device's exclusive writer capability.

While working, exactly one workspace is active. It may reference multiple vaults;
switching workspaces does not copy them. The workspace selector lives only at the
bottom of the left navigation pane, below its scrolling content, in Files, Search
and Graph on desktop and mobile. Edit workspace opens its settings tab. Close workspace returns to the
starting page. Closing and switching offer Save, Discard and Cancel for dirty
files. After confirmation, editors unmount, pending plugin prompts are dismissed,
extensions and sync connections stop, native folder leases and the browser writer
lock are released, and the session is discarded. An unsuccessful vault open uses
the same cleanup before displaying its error on the starting page. Ordinary
workspace settings, files and sidecars remain on disk.

`WorkspaceCatalog` reads only the app-private `workspaces.json` list of IDs,
names and storage roots. It does not open a `WorkspaceStore` or create a workspace.
The catalog stores no selected workspace or editor session. `WorkspaceLibrary`
opens the workspace selected by its caller. Headless runtimes choose the first
saved workspace when no explicit selection is supplied. Each workspace has
portable JSON settings and an optional Automerge archive when history or sharing
is enabled. Internal workspaces use the app-private root or `workspaces/<id>/`; Folder
workspaces keep their JSON at the selected location. The catalog and local folder capabilities are outside
vault contents. Plugin installations and diagnostics are computer-local;
enablement and configuration remain per-workspace settings.

Vault synchronization routes also live in app-private storage, so opening the
same vault from another workspace keeps its existing file connections. Shared
workspace settings are indexed separately by workspace ID. An inactive
workspace cannot adopt the active workspace's settings or automatically acquire
its newly opened vaults. Revoked routes are detached during restart while their
local files and settings remain available.
Vault discovery uses the active document in memory, avoiding a read of the
active snapshot while a layout Save publishes its replacement. An explicit
regression simulates that unreadable File snapshot; repeated production
workspace-switch checks cover the complete flow.

## Shared menu declarations

`UIContributionRegistry` accepts namespaced, inert entries with stable ordering
and resource conditions. Core registers creation, rename, delete, history,
sharing, editor commands, navigation and settings entries. Verified plugins use
the same named locations through manifest declarations. One shared renderer
composes unmodified shadcn dropdown and context-menu primitives. Removing a
plugin removes its registrations; declarations never run commands on arrival.

Explorer rows keep normal left-click opening/expansion. Right-click anywhere on
the row, the three-dot trigger, and the matching file or folder breadcrumb use the same
menu content. Selection includes the action trigger. Root folders and nested
folders share tight spacing and indentation lines. File drops use the dock's
existing percentage-based protocol, including editor selection when needed.

The right settings pane is navigation only: Workspace, Sharing, Plugins, Keyboard
shortcuts, Local logs and individual installed-plugin settings. The pages open
in the ordinary dock. Graph and comprehensive search do too. Plugin settings
include the selected defaults/computer target, declared configuration. Templates and named keys belong to their target files/folders. Duplicate named keys are supported. Installing/uninstalling stays in the plugin manager.

## Local diagnostics

[LogTape](https://logtape.org/manual/start) supplies the portable structured
logging interface. `LocalLogStore` persists bounded JSON-lines shards through an
explicit filesystem capability. There is no telemetry endpoint or Automerge
document for logs. The retention policy is 14 days, with daily cleanup and a
2 MiB cap per UTC day. Old entries in a full daily shard are discarded first.
Queries display at most 10,000 records and the table renders at most 1,000.

Common credential fields, private-key blocks, sync links, Automerge URLs and URL query
strings are redacted. A single application-level Sonner subscriber displays warning, error and fatal
log records, including on the launcher. Callers log failures instead of deciding
whether to toast. Repeated notices are deduplicated; full redacted details remain
in the log. View logs opens the workspace logs tab or a launcher dialog.
There is no notification-to-log feedback loop.
Local logs supports source/message search, severity filters, export and
clearing. Core services, plugins, sandboxed editors, uncaught errors and rejected
promises have reporting paths. Diagnostic failures do not reject a document Save.

## Sharing and disconnection

The sharing table has a **Broadcast** column. Its header switch controls this
app's relay and local-tab connections and defaults off. Row switches control
sharing at that row's workspace, vault, folder or file scope. Turning the header
off pauses all exchange and displays the saved rows without network connections;
it preserves their individual choices, permissions, files and histories. Turn it
on to resume enabled scopes. The selected relay remains configured while paused;
there is no separate Offline connection option. Changing the relay reconnects the
sync service without closing the workspace or changing unsaved drafts.

History and Sharing dialogs use **Unset / Disabled / Enabled** controls above their
tables. Unset removes the item's override and inherits the closest enclosing
setting; at the workspace it resolves to off. Disabled is an explicit exception,
including when a parent enables the feature later. Enabled applies at this item
and passes down to children without their own override. Broadcast remains a
separate pause/resume choice for each share and for this app.
Disabled shares remain listed in the global Sharing settings while their root
is open, so their references and Broadcast choices can be inspected and resumed.

History and Sharing use the same popup dimensions and shared overview layout,
with the hierarchy fixed at the bottom and the content above scrolling separately.
Both show the scoped folder above its child folders and files, with children
aligned beneath their own parent as each level is loaded. Parent cells span the
columns of their descendants. Cells touch without inner borders. The top outside
corners and the first and last cells of the deepest visible row are rounded; the
ellipsis sits outside the rounded cells. Loading another level moves the bottom
corners to that new row. Green intensity represents the number of rollback
versions in each item's History table, or effective share rows covering it in
Sharing. A row counts once regardless of member count; paused Broadcast and
items with sharing disabled count as zero. Overlapping workspace, folder and
file shares count independently. Share coverage respects stable file IDs and the
opened folder boundary. Icons directly after the name show **Unset**, **Disabled**
or **Enabled**, independently of the count. Explicitly disabled items use red;
Unset descendants inheriting Disabled use lighter red. Other zero counts use
neutral grey; empty space is transparent. Disabled History exposes no rollback
rows or restore actions, even while a shared archive awaits cleanup agreement.

The numeric legend uses a linear green scale from the least positive count to
the maximum across the whole diagram, including ancestors and unloaded levels.
Its light and dark theme endpoints stay visibly separated from the background;
hover darkens the existing fill. Expanding levels never rescales the colors.
The current item uses bold text and a heavier icon stroke, with **Current** beside
its setting icon; the bold label does not change its cell's dimensions.
Automerge change statistics supply version counts without generating snapshots
or diffs. Saved counts live in each binary record index, allowing lazy files to
be counted with bounded reads and concurrency. Raw archive records are counted
once per content stamp. Workspaces use the
same distinct workspace icon in this hierarchy, menus, workspace selectors, and
workspace settings.

Every potential ancestor appears above the selected item, without sibling
branches, stopping at the mounted boundary. Overrides do not remove ancestors
from the diagram. Clicking any item replaces the popup with a fresh popup for that
item, using the context-menu opening path without enabling the feature. There is
no hierarchy Back button; Back in a version diff still returns to its versions.
The descendant hierarchy starts with the current item; the centered **…** button
reveals one additional row until every level is visible. It fills the row width
and has the same height as a hierarchy row, with rounded button corners separate
from the rounded file/folder cells. It scrolls independently of the versions and
sharing tables, without loading file contents or histories. The title's
information button explains inheritance and the feature's effects. The sharing
table starts with an add-access row only when Sharing is explicitly Enabled
on the current item. Unset keeps inherited access and shows **No shares defined
here.**; Disabled blocks access and shows **Sharing is disabled.** The direct
share form and membership controls are absent in both modes. Broadcast cannot
enable a disabled policy. Unset alone creates no companion; clearing the last
explicit setting removes an otherwise unused companion. History records
history-setting changes as **Enable history** or **Disable history**, reserving
**File created** for the initial file change.

An item dialog fixes the item being shared: workspace, vault, folder or file.
Only that item's membership is editable there. Its table includes inherited and
descendant shares, which open their own dialogs. Trash actions disconnect a
whole share; membership trash actions revoke one participant. The workspace
Sharing page lists shares across open vaults and owns contact cards, relay
selection and invitation intake.

Joining from the Sharing page requires a destination vault and an explicit folder choice for file or
folder shares. The launcher uses the shared folder name or the destination vault root. A local folder can be selected from the invitation interface.
Whole-vault identity adoption still requires an empty destination. Collisions
with unrelated files remain errors. An explicit `/` folder destination maps to
an empty vault root; omitting a folder destination in the core API retains its
source-name default.

Revocation changes authorization and stops future sync; it does not publish file
deletions. Disconnection removes local routes and retires unused protected
transports while keeping files and history. Retained copies can be edited and
shared independently. Live overlapping shares keep their established document
transport. Lowering edit access to read revokes the stronger grant before adding
the lower one.

[Pushwork](https://github.com/inkandswitch/pushwork) was reviewed for its explicit
clone destination and per-file document model. Jocki keeps its existing
Keyhive scope contracts, local capability selection and independent workspace
settings; no Pushwork source was copied.
