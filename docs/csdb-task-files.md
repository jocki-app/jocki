# Tasks in CSDB

Jocki uses `@csvdatabase/csdb/portable`, the official browser-capable entry point of `csdb-typescript`. Its parser, codecs, validator, SQL parser and executor are shared with the native library. The dependency is a reproducible local package snapshot in `vendor/`; the snapshot includes the portable entry point. Rebuild the package from the sibling `csdb-typescript` repository and refresh the lockfile integrity when updating it.

Jocki never assembles CSDB YAML/CSV or mutates parsed tables to save an edit. `CSDBDraft` uses official `table().insert/update/delete`, `batch`, `createSchema`, `createType`, `createTable`, `alterTable` and SQL commands. `FileVault` then persists the serialized result and Automerge cell state durably before acknowledging Save. View settings are workspace preferences; column labels and controls are comments on the actual table definition. Field visibility is the native `visibility` mapping, and references come from native `foreign_keys` definitions, including `label_field`. Choices, arrays, nullability and defaults are native CSDB declarations. There are no items, column-definition or table-definition data tables in a task file.

A task content file contains exactly one `public.tasks` table. Its minimum columns are:

| Column    | Native type | Purpose                           |
| --------- | ----------- | --------------------------------- |
| `id`      | text        | Independent row primary key.      |
| `uid`     | text        | Required iCalendar VTODO UID.     |
| `dtstamp` | timestamp   | Required iCalendar VTODO DTSTAMP. |

New files start with only the three independent identity/time columns. The UI generates IDs and DTSTAMP when inserting tasks. UID/DTSTAMP are generated and protected in the column editor. Optional templates provide title, native enum status, parent, notes, description, sorting, priority, tags and due dates. Required columns cannot be removed through the task view or on Save. When present, task status is a native enum supporting `open` and `done`.

The collection view provides filters, grouping, drag sorting and an inline column editor. Adding, changing, reordering or removing a column calls `alterTable` on the real definition, converts/backfills existing rows, and validates constraints atomically. Invalid changes retain the previous draft. Removing a column removes its stored values; hiding a column only changes view preferences. A primary key is required for uniquely targeted generic row edits. Column IDs remain stable once created.

Each task has a save/status icon: unsaved edits show Save, a pending durable write pulses, and a successful save shows a disk. The adjacent delete action becomes Discard while the row is dirty. A task save applies only that row through native CSDB commands, preserving other private rows and metadata. The header saves the selected tasks together, or all dirty tasks when nothing is selected. Column definition changes use Save in the Columns view. With history enabled, hold a row or header Save for half a second to enter a version description; Alt+Down opens the same popup from the keyboard. Descriptions use Automerge's native change message. These saves still produce versions of the single CSDB file.

Task files with a scalar parent relationship initially open as recursive parent trees, with parent records materialized in place and Sorting applied when available. Saved view preferences override these defaults. References use `foreign_keys.columns` and `references.columns`; native task parents refer to row `id`, independently of VTODO `uid`. `parent_id` declares a self-reference to `public.tasks` and normally uses `label_field: title` for its dropdown labels. In recursive mode, a materialized reference label becomes the grouping field: a saved Notes/Parent combination follows Parent instead of collecting unrelated trees into a shared Notes bucket. Individual grouping keeps its ordinary value buckets. The first visible table column indents each task by its ancestry depth.

CSDB **Tables** and **Tasks** use the same row save/status icons: Save for edits, a pending icon during persistence, and a disk icon once saved. Edited rows offer Discard in the delete slot. Select rows to save them together from the table header; hold Save to add a version description when history is enabled. These row actions use the selected-row storage API, which requires a single `id` primary key with string values. Other key layouts use the file-level Save control.

## Native types

The picker offers text, varchar, integer, bigint, real, numeric, boolean, date, timestamp, json and enum. Any scalar can use one-value or typed-array input; selection modes store native options. Array bounds and selection uniqueness are enforced by CSDB. Named types are resolved within the owning schema and retained when only a label or display setting changes. Big integers and exact decimal values retain their precision.

Types without distinct native CSDB equivalents include UUID, smallint, time-only, timezone-specific timestamp, interval, binary/bytea and JSONB. UUID generation remains a host action that produces text; it does not add UUID validation to CSDB. Native timestamp accepts ISO text with offsets, but CSDB has no separate timestamptz type. `real` is the available floating-point type; `json` is the available JSON type. Unsupported types are excluded from the picker and are not silently serialized as text or JSON.

CSDB's new library interface supplies portable in-memory commands, atomic batches and table-definition alteration. Column renaming and reusable-type alteration do not yet have dedicated commands or GUI controls. SQL supports the existing compact DDL subset; the column editor calls `alterTable` directly.

## Copying a task vault

`sh scripts/with-node.sh node --import tsx scripts/copy-task-vault.ts <source-folder> <new-folder>` creates an independent Jocki v1 vault from a task folder. The destination must not exist. It preserves task cell values and other visible files, orders the working columns, hides import metadata by default, and saves the task content type in the `resource.json` record of `.tasks.csdb.saddle` through FileVault. Table presentation changes use CSDB `alterTable`. Source replica metadata and OS `.DS_Store` files are excluded, giving the copy its own identity so both folders can be opened. It reads a checked source snapshot and verifies task values after reopening the destination.

Jocki v1 is the application storage layout. CSDB document headers use the independent `version: 2` required by the CSDB library.

## Attribute form

Open with > CSDB > Attribute form opens a new-row form. Switch the row selector to edit an existing row. The same typed inputs used by the collection editor render native enum/array options, defaults and foreign-key labels from every table in the file. Forms use one column on mobile and two on desktop. `visibility` values understood by Jocki are `editable`, `viewable`, `hidden` and `addable`; CSDB stores arbitrary visibility text without enforcing it. Unknown values are preserved when unrelated column settings change.

New form values remain in the editor's local buffer until Apply/Add row or the file's Save. The header Save flushes the form, validates through CSDB commands, then performs the normal durable save. Close, workspace switching and unload prompts include pending form values. Row navigation applies pending valid changes to the draft; invalid input prevents navigation. Imports opened as forms provide Previous/Next controls in the document toolbar. The form uses structured `update` commands with `row_indices` for tables without keys; row positions are checked against the editing baseline before applying.

```yaml
visibility:
  id: hidden
  title: editable
  notes: addable
foreign_keys:
  - name: tasks_parent_fkey
    columns: [parent_id]
    references:
      table: public.tasks
      columns: [id]
    label_field: title
    relationship: parent
```

## Add data and import profiles

A CSDB file's context menu offers Add data > Choose file and Add data > Template > source file. The default profile supplies these actions; each named import profile also appears as a submenu. Imports merge into the destination file, leaving their sources unchanged. The reusable file picker supports workspace and device files, folder selection, extension filters, search and multiple selection. Callers supply root/entry capabilities and read callbacks; the picker has no CSDB-specific storage logic. Device folder results include readable child entries.

Settings > CSDB imports defines profiles and the default profile. Each profile selects row/definition conflict policies, missing table/column/reference policies, transferred sections, optional table mappings and row/column selectors. A single source table can automatically map to a single destination table. Selection JSON uses the SDK's qualified `source`/`target` names, `columns`, and intersected `rows.indices`, `rows.keys`, or structured `rows.where` expressions.

Presentation options are Data table draft, Attribute form draft and Save automatically. Draft imports open/focus the destination view and do not persist until Save. Automatic imports save through FileVault without opening or focusing an editor; they reject unsaved destination drafts. They work with history disabled and attach a normal history description only when history is enabled. Profiles live in workspace settings at `plugins["core.csdb"].configuration`, using ordinary workspace inheritance.

All import paths call the official CSDB `merge` API. Multi-file imports merge in a private SDK instance and publish one final draft after all inputs succeed. Primary-key conflict policies are error, skip, update (selected columns) and replace (reset other columns to defaults/null). Missing columns can error, be added or be ignored. Foreign-key policies can reject, drop invalid definitions, or null unresolved nullable references, reporting deliberate changes through the logging/notification system. Enums, arrays, required values, unique keys and self references validate before applying the result. Named types resolve in their source schema, so moving a selected table into another schema does not reinterpret its types.

See the CSDB SDK/specification merge documentation for the full JSON contract. `comments` transfers structured comment mappings; it does not copy YAML layout comments or machine indexes.

## Workout templates and current dates

`date` stores a calendar day. `timestamp` stores a date and time; `datetime` is an alias for `timestamp`. Date/time values can have a per-column text format in the table definition:

```yaml
schema: public
name: exercises
columns:
  name: text
  sets: integer
  reps: text
  date: datetime
required: [name, sets, reps]
defaults:
  date: now()
formats:
  date: "%d/%m/%Y %H:%M:%S%:z"
visibility:
  date: hidden
```

`formats` maps existing date/time columns to format strings. This controls their **CSV representation**, not a time zone conversion or a frontend visibility rule. It is optional; without it dates use `YYYY-MM-DD` and timestamps use ISO text. A reusable named date/time type may also declare `format`; a table's `formats` entry overrides that type's format. Formats on non-temporal columns, unknown columns, invalid directives, missing calendar parts, and invalid calendar dates fail validation, including when the table is empty.

Formats use a portable, locale-independent subset of strftime. Combine directives in any order with arbitrary literal separators; quote strings containing `%` in YAML.

| Directive | Meaning |
| --- | --- |
| `%Y` | Four-digit year, 0001–9999 |
| `%m`, `%d` | Two-digit month and day |
| `%H` | Two-digit hour, 00–23 |
| `%I`, `%p` | Two-digit hour, 01–12, and `AM`/`PM`; use together |
| `%M`, `%S` | Two-digit minute and second |
| `%f` | Six-digit fractional seconds |
| `%z` | Offset such as `-1000` (`Z` accepted on input) |
| `%:z` | Offset such as `-10:00` (`Z` accepted on input) |
| `%%` | Literal percent sign |

Each format requires exactly one `%Y`, `%m`, and `%d`. Directives cannot repeat. Date formats cannot include time or offset directives. Timestamp time components omitted by the format become zero on read; omitted fractional seconds and offsets are not retained. Choose a format containing the precision and offset you need. A format containing an offset directive requires a timestamp with an offset. Unsupported directives fail explicitly.

JavaScript SDK row values remain canonical ISO strings. Python row values remain native `date`/`datetime` objects. Supply canonical ISO strings or native Python values to insert/update. The SDK translates them to the configured CSV format, and translates the file back on read. Merely opening or serializing a file never evaluates a default.

## Current time

The exact string `now()` (case insensitive) is a built-in default for `date`, `timestamp`, and `datetime`. It is evaluated in UTC when an insert omits the column. All rows in one insert or merge use the same captured time. For `date`, it yields the UTC calendar day. For `text`, `now()` remains literal text. No general expression evaluation, JavaScript execution, Python execution or network access occurs. Other temporal default values must be valid typed literals.

Explicit null remains null. Parsing, saving, querying, updating another field, or synchronizing existing values does not refresh a timestamp. A new form can call `evaluateDefaults(table, now?)` in JavaScript or `evaluate_defaults(table, now=None)` in Python to initialize defaults without modifying the table. Those helpers resolve only defaults, not required values for unrelated columns.

## Reusable populated templates

A template can have blank nullable date cells and `defaults: {date: now()}`. Blanks remain null in the template itself. A merge can deliberately fill incoming nulls from destination defaults:

```js
destination.merge(template, { nulls: "defaults", missing_tables: "create" });
```

```python
destination.merge(template, {"nulls": "defaults", "missing_tables": "create"})
```

The default merge policy is `nulls: "preserve"`. `nulls: "defaults"` applies to selected incoming columns that are null and have a destination default; non-null source values and unrelated existing destination rows are preserved. Selected updates and replacements use the same rule. Defaults/format definitions are structural when creating a missing table or column; existing table definitions change only when selected by `include` and the metadata conflict policy. `include: ["formats"]` transfers a table's format map independently of its data. The whole merge remains atomic.

Jocki's CSDB templates are instantiated through these SDK commands on creation or template import. Both bundled full-body workout templates have six exercises, no video column, three sets per exercise, their supplied rep ranges, and a hidden `date` column with `now()`. Their template files keep blank date cells, so reusing them produces a fresh timestamp. Existing populated date cells retain their saved value. The default import profile fills blank values from defaults and includes visibility; custom profiles can choose either behavior.
