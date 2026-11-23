# Shared column customization

A plugin opts into independently configured tables with `RecordSchema.tables: true`. Core creates each new table with only the fields required by its contract or standard. VTODO requires UID/DTSTAMP; VEVENT without METHOD also requires DTSTART; VALARM requires ACTION/TRIGGER and validates its conditional fields when saving. Generated required fields do not need manual entry. A contract with no required fields may have an empty column list. Existing user-configured tables are preserved.

The Columns page lists optional standard fields as clickable **templates**. Adding one copies a descriptor into that table; it can then be renamed, reordered, removed, or customized. Optional templates are not permanently locked to their original type. Required standard contracts remain locked. The generic Tables UI and every plugin Columns page use `ColumnsTable`: each row edits its descriptor in place, with save, discard, reorder and remove icons in the first column. New columns appear as a blank row. Required descriptors keep their contract controls locked while allowing label and compatible visibility edits.

## Type and number of inputs are separate

```ts
field("scores", "Scores", "integer", {
  storage: "custom",
  inputMode: "multiselect",
  array: true,
  options: [1, 2, 3, 4, 5],
  minItems: 1,
  maxItems: 3,
  required: false,
  nullable: true,
  default: [3],
  visibility: "editable",
});
```

`pgType` describes one value. `inputMode` describes how many values and how they are entered:

| Input mode    | Stored shape            | Control                                       |
| ------------- | ----------------------- | --------------------------------------------- |
| `single`      | scalar (`array: false`) | Base-type input                               |
| `select`      | scalar                  | Shared select with typed options              |
| `list`        | array                   | Repeatable base-type inputs                   |
| `multiselect` | array                   | Multiple typed selections, without duplicates |

`minItems`/`maxItems` constrain list length; equal values specify a fixed number of inputs. Options retain the scalar's type: integer options are numbers, booleans are booleans, and exact numeric/bigint options are strings. Core validates option types, duplicates, count limits and defaults. `required` controls absence; `nullable` controls explicit null. Scalar type constraints remain those of the shared PostgreSQL descriptors.

Visibility is a presentation choice, not access control:

- `editable`: show an editable control.
- `viewable`: display in forms with editing disabled; plugins can populate it through core.
- `hidden`: omit from forms; off by default in tables, but available in the Columns dropdown.
- `addable`: available in the table column picker; standalone forms may put it behind an optional-fields disclosure.

Required hidden/read-only columns need a default or generated value. `fieldVisibilityOptions` supplies the shared policy: generated columns offer Read only and Hidden; required columns without a default offer Editable; other columns offer all four choices. Visibility changes never relax a required field’s type or generation contract. Every platform and plugin uses `FieldInput`, `RecordForm`, `ColumnEditor` and the shared collection presentation rather than its own codecs or native select elements.

## Storage and interoperability

User columns live in `custom_fields`; generic table rows use `values`. Templates are plain field descriptors. There is no automatic behavior or mirroring based on a custom column's name.

A plugin table declares explicit `bindings`, mapping a plugin contract field (feature role) to the configured column ID:

```ts
{
  name: "Work",
  collection_id: "tasks",
  columns: [/* required fields, plus ordinary custom descriptors */],
  bindings: { title: "caption", status: "progress" }
}
```

The Columns page exposes the mappings in each row’s **Plugin feature** cell. Templates above the table populate its always-present first creation row. They remain unsaved and editable until the user clicks the plus button; clearing the row discards the draft. Templates default to plugin storage, and Storage is chosen in the row. Adding a column does not assign or change feature mappings. Choose a feature explicitly in that column’s dropdown to connect it to plugin behavior. The selector offers behavioral fields only, rather than every metadata or interchange field. Additional plugins declare the canonical fields they actually consume using `featureFields: ["enabled", "trigger"]` on their collection schema. A collection without declared behavioral fields has no Plugin feature column. Bound fields must agree on scalar type and cardinality; values must satisfy both descriptors. A column can supply only one feature per table. Unmap a column before giving it an incompatible type.

Core projects the chosen column into the plugin contract, and plugin API edits update the chosen column. This allows plugins to continue using their declared feature API while users choose their column names. Updating a table's mappings refreshes existing records through signed core writes. Bulk operations are sequential durable writes, not a cross-record or cross-device transaction. Required standard fields retain their protocol constraints; optional templates have no special input code.

Removing a column hides it without erasing its stored values. Re-add its stable ID to expose those values again. Editing a table validates its existing rows; an incompatible type change is rejected instead of silently coercing data. The table definition itself replicates through Automerge. Selected table, view configuration and local search projections remain device state.

Use `collectionColumns`, `customValues`, `templateValues` and `validateTableValues` from the SDK when adapting a legacy store. Ordinary plugins use core records and receive this validation automatically. Standard conditional requirements remain enforced independently of which optional templates the user has selected.

## Reusing the inline editor

```tsx
import { ColumnsTable } from "@jocki/ui/columns-table";

<ColumnsTable
  columns={columns}
  locked={requiredColumnIds}
  disabled={!canWrite}
  creating={creatingColumn}
  onCreatingChange={setCreatingColumn}
  onSave={async (next) => {
    await persistColumns(next);
  }}
  featureCell={(column) => renderFeatureSelect(column)}
/>;
```

Supply the latest saved descriptors in `columns`; await durable persistence in `onSave` and reject on validation or persistence failure. A failed save keeps the row draft and displays the error. `locked` contains required column IDs, which cannot be removed or change type. Omit `featureCell` for tables without plugin bindings. The caller opens a blank row by setting `creating` to true; saving or cancelling it calls `onCreatingChange(false)`.

`ColumnEditor` still supports standalone forms for compatibility. Its optional `render` callback exposes named `cells`, an async `save()` function and the current `error`, so custom table presentations can reuse the same descriptor controls and validation. Use `FieldInput` from `@jocki/ui/fields` for individual record values; it chooses the editable control from the field descriptor. Use `RecordTable` for record lists to retain permission checks, draft saves, sync status and shared query controls.

Main tables use the configured column order and descriptor visibility as their defaults. Editable and read-only columns start visible; Hidden and Add when needed start off. Saved local view preferences take precedence; Reset columns restores the latest definitions, including their order.
