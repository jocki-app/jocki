# Shared collection views

Use `RecordTable` for plugin collections. It supplies the shared Filter, Sort, Columns, Group and View controls, durable device-local preferences, permission checks, schema-based inline inputs and all six presentations. The Columns button always says **Columns**. There is no free-text entry search; use a typed filter. Opening a control closes the previous control in the same table. Nested field selects remain part of their parent popup.

```tsx
/// <reference types="@jocki/platform/host-types" />
import { RecordTable } from "@jocki/ui/record-table";

<RecordTable
  runtime={ui.workspace}
  collection="example.entries"
  viewKey="example.entries.main"
  defaultView={{
    mode: "short-table",
    columns: ["title", "status", "priority"],
    groups: [
      { id: "status", field: "status", enabled: true },
      { id: "priority", field: "priority", enabled: true },
    ],
  }}
/>;
```

Import the component through `core.ui.modules`, or use `core.ui.RecordTable` directly without its `runtime` prop. Core checks declared collection access for both. Tables in separate surfaces should use distinct, stable `viewKey` values when their preferences should differ. Preferences are local to this device and workspace; they do not execute or schedule replicated work. Existing `groupBy` preferences migrate to the first grouping rule; retired saved entry searches are discarded. A new `defaultView` is used only when no saved preference exists.

## Loading and query performance

`useLiveQuery` from `@jocki/ui/storage` runs at most one read at a time and combines bursts of changes into one follow-up read. Completed snapshots are shown in order while background updates continue; loading does not wait for every storage write to stop. Changing the query source discards results still in flight. Unchanged JSON snapshots retain their references, so unrelated metadata writes do not rebuild tables. Treat query results as immutable snapshots; write through the collection methods. Include the workspace, collection and schema selection in query dependencies so changing the source clears the old snapshot immediately.

Core applies collection equality filters before copying cached records. Table views reuse the selected table definition rather than reading it again for every list request. Filter values, enabled sort clauses and search text are prepared once per shared query. Writes, authorization and durable-save acknowledgements still go through the existing core services.

If a plugin already loads a collection for another panel, pass that snapshot as `rowsOverride` to `RecordTable` with its normal `storeOverride`. The table displays those rows directly and does not make a duplicate list request. Keep transformed rows and schema overrides memoized. The store still handles edits, deletes and fresh reads required by actions; supplying rows does not authorize a write or bypass core validation. Track uses this path for its session panel and Entries table. Ticking clocks update separately from historical rows.

Use `LoadingSpinner` from `@jocki/ui/loading-spinner` while a query returns `undefined`. It displays one centered circle with an accessible status label, without skeleton blocks. `RecordTable` supplies this automatically for its own initial reads. Keep existing rows visible during background refreshes. Do not render page introduction paragraphs; the host also suppresses the `page-description` class in downloaded plugin pages.

```tsx
import { LoadingSpinner } from "@jocki/ui/loading-spinner";

if (rows === undefined) return <LoadingSpinner label="Loading entries…" />;
return (
  <RecordTable
    runtime={ui.workspace}
    collection="example.entries"
    storeOverride={store}
    rowsOverride={rows}
  />
);
```

## Rules and data

Filters and sorts use `@jocki/platform/field-types`. Filter rules are applied from top to bottom, joining each subsequent enabled rule using its And/Or setting. Up/down buttons change that order. Turning a rule off retains its configuration. The first filter's Where label occupies the same column width as subsequent And/Or selectors. Sort rules have the same ordered, enabled model; clicking a column header promotes that field to the first sort. Sort and Group rows place their enable switch immediately after the up/down arrows.

Columns uses the same arrows and switches in a searchable popover; its search only finds column names. Column order is saved separately from visibility, so hiding and showing a field preserves its position. `columnOrder` stores all field IDs, while `columns` contains the visible IDs in display order. Existing preferences migrate automatically; custom `QueryControls` consumers can persist the optional order argument from `onColumns(visibleIds, orderedIds)` and pass it back as `columnOrder`.

Group rules contain `{ id, field, enabled }`. Enabled fields partition the already filtered and sorted rows recursively, in rule order. Each leaf retains the input sort order. Groups are ordered by the shared typed comparator; unset values appear last. Group IDs are based on field IDs and canonical values, not display labels. Large integers and decimals retain precision; timezone-aware instants retain microseconds. Equivalent numeric representations and timestamp offsets share a group. JSON objects use sorted keys; arrays group by the entire ordered array rather than multiplying records across values. Missing and null values share the **Not set** group. Duplicate enabled fields are ignored defensively, and the UI prevents adding duplicates.

All six views use one path of `{ field, key }` segments, one breadcrumb and one collapsed-group set:

| View               | Presentation                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Short table        | Fixed-width table, aggressively wrapping cell content.                                                                   |
| Long table         | Unwrapped cells, horizontal scrolling within the table.                                                                  |
| Board              | Nested horizontal groups; field/value headers remain visible horizontally within their group. Leaf groups contain cards. |
| Short table folder | Group folders at each depth, then the short table at the leaf.                                                           |
| Long table folder  | Group folders at each depth, then the long table at the leaf.                                                            |
| Board folder       | Group folders at each depth, then cards at the leaf.                                                                     |

A group heading includes field, value, record count, collapse/expand and a right-arrow open action. Opening a group restricts the displayed subtree and appends a breadcrumb; selected ancestor headings remain above its contents. Folder clicks perform the same navigation. Breadcrumb ancestors return to the corresponding depth. Changing view preserves the path. A path whose values disappeared or whose grouping order changed resolves to its longest valid prefix. Without grouping rules, folder modes show their underlying record view immediately.

## Extension points

`RecordTable` accepts `toolbar`, `onOpen`, `renderActions`, `hideCreate`, `readOnly`, `schemaOverride`, `storeOverride`, `columnOptions`, `renderCell` and `renderCard`.

- `columnOptions[fieldId]` can set `header`, `width` and `className`; keep field IDs aligned with the schema.
- `renderCell(context)` receives `row`, `field`, `value`, `defaultContent`, `writable` and `update(patch)`. Return `defaultContent` for fields without a specialized display. The default content is the shared inline editor. Preserve it unless the plugin needs a specialized presentation. Only enable editing when `writable` is true; await `update`, handle its rejection and retain the user's draft on errors. The host rechecks access, reads the current record and merges the patch through the collection store. Core validation and durable write behavior remain in force. This is not a cross-device transaction.
- `renderCard(row, defaultContent)` customizes card contents while retaining the shared board/group navigation. `renderActions(row, { writable, update })` adds record actions in tables and cards using the same permission-checked update path.
- `storeOverride` must preserve the core collection contract and permissions; it does not grant access. Writes resolve after durable persistence.

For specialized storage adapters, compose the exported pure `CollectionView`, `QueryControls`, and functions/types in `@jocki/ui/collection-view-model`. Pass rows already filtered/sorted by `queryRecords`, normalized `CollectionViewState`, and an `onChange` callback. `CollectionView` never writes storage itself. Supply `writable` and `onUpdate` to support editable cells; absent callbacks make its update context read-only. Keep the shared rule controls and breadcrumbs instead of implementing a parallel system.

## Shared components and compatibility

The local primitives were downloaded with the official [shadcn CLI](https://ui.shadcn.com/docs/cli), using the Base UI `base-nova` registry. `packages/ui/shadcn-registry.json` records the command, CLI version, date and SHA-256 hashes. `npm run ui:verify` ensures all 24 downloaded source files remain unchanged. Theme tokens use shadcn's neutral defaults; application layout and view composition live outside primitives. To update, run the recorded command with the current CLI, inspect its dependency changes, refresh the provenance hashes, regenerate UI declarations and run the browser checks.

Use `FieldInput` and `RecordForm` for schema fields, `ChoiceSelect` for application choices, and `@jocki/ui/primitives/*` for composed controls. Every downloaded primitive is exported in the host module map. These use Base UI's `render` composition prop, not Radix's `asChild`. Do not bundle another React instance or copies of the core components. The generated host declarations reflect the actual component APIs (`npm run ui:types`, also part of `sdk:build`). Plugin TypeScript projects that import primitive types need matching development type dependencies: React, Base UI, class-variance-authority, react-day-picker and sonner as applicable. Runtime UI imports remain external through the standard plugin builder.

Existing signed v1 plugins receive a compatibility React/JSX facade mapping their intrinsic select, input, checkbox and textarea elements onto the downloaded controls. It preserves their value/change boundary without modifying signed package bytes. New plugins should use explicit shared components; the compatibility adapter is not a complete emulation of HTMLSelectElement methods or DOM refs. The v1 Tasks surface uses the shared collection view with its completion action, replacing its separate board implementation.

## Verification

`tests/collection-view.test.ts` checks recursive partitions, exact typed identities, stale breadcrumbs, migration and rule ordering. `tests/browser/collection-views.mjs` exercises real plugin installation and CRUD, filtering, ordering, column selection, exclusive popups, collapse/drill-in, all six modes, reload persistence and narrow viewports. Run it against a running web app using `TEST_APP_URL`. The published-plugin and offline browser suites cover host compatibility and downloaded-package behavior. `tests/browser/inline-records.mjs` covers inline creation, parent selection and cycle rejection, bulk saves, reload and bulk deletion.

## Inline rows and bulk actions

`RecordTable` renders a creation row first, with shared `FieldInput` cells and a plus button. Existing rows have their selection checkbox and Save, Discard, and Delete controls on the left. Header controls save, discard or delete the selected rows. When reference grouping is active, Delete expands the selection to all descendants through those grouping fields in the current table/store, including filtered and collapsed rows. The confirmation shows the total count and descendant count. Permissions and pending writes are checked for the entire branch before any optimistic deletion is staged. Ordinary value groupings do not imply ownership or cascade. Low-level core deletion remains explicit; receiving a replicated deletion does not execute a new cascade. Validation failures retain drafts; successful rows are committed durably. Saves merge the edited fields into the latest local record instead of overwriting unrelated changes that arrived during editing.

All six views share the same editing adapter. Boards use editable cards and the same creation controls; folder views keep the same controls at their current location. Generated values and managed/read-only resources cannot be edited. `onOpen` is for opening a resource (such as a file or specialized workflow page), not for opening a record-edit dialog. Optional `renderBulkActions(rows, { update, busy })` supplies a bulk counterpart to plugin-specific row actions; Tasks uses it for completion.

`CollectionView` is the presentation component underneath. Its `createRow: { cell, actions }`, `headerActions`, `rowDetails`, and existing `renderCell` hooks support custom stores without duplicating grouping, folder navigation, breadcrumbs, or the table layout. Credential secrets and execution settings remain separate from record data and use their existing protected core services.

Table presentations place row creation, selection, save/discard, sync and plugin action controls in the first column. Action strips do not wrap; the table scrolls horizontally when needed. Tasks use the inline Status field instead of a separate completion checkmark.

Grouping rules may set `labelField` to display the distinct typed values of another field across the group's rows, joined with `/`. Labels do not change group identity, membership or creation defaults. `mode: "individual"` (the default) groups exact field values. `mode: "recursive"` nests groups through declared scalar references to rows in the current table scope. Ordinary fields stay individual. Missing/ambiguous targets stay at the root; cycles are broken deterministically without dropping records. Later grouping rules subdivide the direct rows at each reference level, so each record appears once. Counts and labels include descendants; collapse hides that branch. Folder views retain direct records alongside nested folders.

Group headers put navigation and the count immediately after the collapse chevron, before the field name. Narrow color strips carry each ancestor's color through headers and records. A randomized hue offset plus golden-angle spacing separates groups, with stable colors while the view remains mounted. Colors supplement indentation and text; they are not the only indication of membership.

A row of chevrons between the breadcrumb and table header controls expansion by depth. There is one for every actual grouping depth in the current branch, including recursive reference levels and subsequent grouping rules. They align with the row chevrons, remain present when ancestors collapse, and start expanded in a new view. Clicking a level collapses every group at that depth; clicking a fully collapsed level expands them. Other depths and branches outside the current breadcrumb keep their state. The controls reflect individual row toggles and use the same saved collapsed-group preferences.

Grouping rules can set `materialize: true` using the checkbox beside a reference field’s name inside the Group popover’s Group value dropdown. That choice sets `labelField` to the reference field. Other field types have no checkbox. Table headers do not expose this setting. The referenced item moves directly below the group heading, replacing the displayed group value. It uses the same table row renderer, cells and column grid as ordinary items; only the grouping controls are indented. When the label reference differs from the grouping field, its distinct targets across that group supply the materialized items. Each item is rendered once; when several groups reference it, the first group in tree order owns its editor. Only unambiguous reference targets present in the current view are moved; filtered or unavailable targets retain the ordinary heading. Recursive reference groups embed each level independently. Materialized items stay visible when their group collapses, participate in selection and group counts, and remain editable in table, board and folder views. This is a saved presentation preference and does not rewrite any reference values.

Recursive reference grouping treats an empty reference as no parent, never as a shared ancestor. Parentless records remain at the current level, while actual reference groups form independent roots. Subsequent grouping rules still apply to those records. Materializing a parent moves it into its actual reference group without introducing a synthetic “Not set” group or breadcrumb. Individual grouping retains its ordinary empty-value group.

The `Sorting` field type is an ordinary text column (`control: "sorting"`). The shared `Sort order` template adds that descriptor without changing plugin behavior. Enable the column in Sort to order by its stored LexoRank strings. Dragging between entries generates a rank using [lexorank-ts](https://github.com/kvandake/lexorank-ts). Empty, invalid, or duplicate bounds are repaired only in the adjacent interval needed for insertion, preserving displayed order. Valid ranks outside that interval are retained; normal moves write only the moved row. Ascending and descending sorting are supported. Earlier sort rules still take precedence; put Sorting first to freely reorder across their values.

`RecordTable` shows a drag handle between selection and row actions when grouping or Sorting is active. Dropping on a group changes the actual grouping values, with the deepest value winning for repeated recursive fields. Later grouping rules remain intact when dropping on a higher-level group. Dropping on the root breadcrumb clears optional recursive references. Every record is a drop target, whether it already has children or appears as a materialized group. The middle half of a row changes grouping: the deepest applicable scalar reference rule points to that row's typed identifier, and other rules inherit that row's membership. Ordinary grouping fields copy the destination row's values. The top/bottom quarters insert before/after the destination among its natural siblings, updating grouping when crossing between sibling sets. Sorting-only views use the whole row for before/after insertion. Materialized parents and leaves share a single sibling ordering in table, board and folder views; a parent's subtree follows its own rank, independently of child ranks. Subsequent grouping rules also retain the parent's natural subgroup position. Moving a parent carries its referenced descendants with it and refuses ancestry cycles. The whole destination group receives a translucent tint matching its left strip; an inset three-pixel line marks ordered insertion without changing layout.

The pure `CollectionView` exposes `onMove(drop)` and supplies a drag handle as the second `renderActions` argument. Hosts can use `planRowMove` from `@jocki/ui/collection-drag` to compute patches, then validate permissions and persist them. `RecordTable` performs this automatically through the same store as inline editing, checks for conflicting unsaved fields, and acknowledges the move only after writes finish. Custom views can reuse `EditActions` from `@jocki/ui/edit-actions`: unedited records show sync/delete, drafts show save/discard. Bulk actions omit sync, and the storage-details button lives inside the item sync popover.

`RowDrop.targetId` identifies a center drop; `anchorId` plus `position` identifies sibling insertion. `path` is the anchor's natural grouping path for insertion or the existing group path for header drops. `planRowDeletion(rows, schema, state, ids)` supplies the shared descendant closure; pass the full table/store rather than filtered rows, check write permission for every returned row, and await durable deletion before reporting success.

## Optimistic writes

Every UI collection from `core.workspace.collection()` uses the workspace's shared optimistic coordinator. This includes plugin-owned collections, authorized cross-plugin collections, generic tables, and column definitions. `RecordTable` and `useLiveQuery` display pending creates, edits, moves and deletions immediately. Continue awaiting `put`/`delete`: their promises resolve only after core validation and durable persistence. Success notifications belong after that await; failures go through `notify.error`, not inline table banners. The coordinator reports failures through the same deduplicated Sonner system.

Previews are held only in memory in the UI. They never enter core records, authorization, execution, sync receipts, or background plugin services. Same-record writes queue in order. Later column edits rebase on the confirmed data after earlier writes succeed or fail. A rejected create disappears, a rejected delete reappears, and rejected edits restore saved values; `RecordTable` also retains the failed draft for correction. Different records remain editable while a write is pending. Workspace shutdown waits for queued writes.

For a custom UI, read pending status without creating a second optimistic store:

```tsx
import { useOptimisticRecords } from "@jocki/ui/optimistic";
const writes = useOptimisticRecords(workspace.optimistic);
const saving = writes.count(record.id) > 0;
```

The shared Item sync status icon becomes an uploading cloud while saving. Its popover distinguishes pending edits from receipts for the previous durable version. A custom `storeOverride` should adapt `workspace.collection()` so it retains this behavior. Keep external effects such as sending mail or executing a command tied to confirmed operations; a preview is never an acknowledgement of those effects.
