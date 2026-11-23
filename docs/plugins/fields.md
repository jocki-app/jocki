# Shared field contract

Every persisted plugin field uses a descriptor from `@jocki/platform/field-types`. The `pgType` names remain the shared vocabulary for validation and widgets. Core maps these definitions to real DuckDB SQL columns on every platform; plugins never select a private storage type. The separate `array` property controls cardinality, independently of the scalar type and input component.

| PostgreSQL definition         | Portable value                                          | Shared `FieldInput`                                                        |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `text`                        | Unicode string                                          | Text input; declared textarea, email, URL or password control              |
| `character varying`           | String with optional maximum code-point length          | Text input with shared validation                                          |
| `uuid`                        | Validated lowercase UUID string                         | Reference selector when `reference` is declared; otherwise text input      |
| `boolean`                     | Boolean                                                 | Switch; nullable fields use Not set / Yes / No                             |
| `smallint`                    | Integer number, −32768 through 32767                    | Number input                                                               |
| `integer`                     | Signed 32-bit integer number                            | Number input                                                               |
| `bigint`                      | Exact signed 64-bit integer **string**                  | Text input that preserves every digit                                      |
| `numeric`                     | Exact decimal **string**, with optional precision/scale | Text input that preserves decimal precision                                |
| `double precision`            | Finite number                                           | Number input                                                               |
| `date`                        | `YYYY-MM-DD`                                            | Date input                                                                 |
| `time without time zone`      | `HH:mm:ss`, optional fractional seconds                 | Time input                                                                 |
| `timestamp without time zone` | Local date/time string without offset                   | Local date/time input                                                      |
| `timestamp with time zone`    | ISO date/time string with `Z` or offset                 | Local date/time input converted to an instant                              |
| `interval`                    | ISO duration string, such as `PT30M` or `-PT10M`        | Text input with duration validation                                        |
| `jsonb`                       | Finite JSON values, nesting limited to 40               | JSON editor with syntax validation                                         |
| `bytea`                       | Canonical base64 string                                 | Text input with base64 validation; use core Files for large binary objects |

## DuckDB mapping

| Field definition                 | SQL column                      |
| -------------------------------- | ------------------------------- |
| `text`, `character varying`      | `VARCHAR`                       |
| `uuid`                           | `UUID`                          |
| `boolean`                        | `BOOLEAN`                       |
| `smallint`, `integer`, `bigint`  | `SMALLINT`, `INTEGER`, `BIGINT` |
| `numeric`                        | `DECIMAL(precision, scale)`     |
| `double precision`               | `DOUBLE`                        |
| `date`, `time without time zone` | `DATE`, `TIME`                  |
| `timestamp without time zone`    | `TIMESTAMP`                     |
| `timestamp with time zone`       | `TIMESTAMPTZ`                   |
| `interval`                       | `INTERVAL`                      |
| `jsonb`                          | `JSON`                          |
| `bytea`                          | `BLOB`                          |

`array: true` adds `[]` to the scalar SQL type, including JSON and BLOB lists. DuckDB decimal precision is at most 38 digits. The default is `DECIMAL(38,18)`; an explicit precision without a scale means scale zero. Shared validation rejects values that exceed the selected precision/scale instead of silently rounding. Length, choices, references and required/nullable rules are enforced by core before a signed write. SQL timestamps preserve microseconds; transport retains exact integer and decimal strings.

`array: true` makes a typed array of the declared scalar, with shared chip controls. Array elements are non-null. `choices` constrains strings and supplies a select control; plugins do not create private SQL enum types. `reference` identifies a core collection and supplies its permitted options. File references are UUIDs, while file contents belong to core's versioned chunk storage.

`required` controls presence, and `nullable` controls whether an explicit null is accepted. Declare both `required: true` and `nullable: false` for a mandatory value. Optional absent fields become null unless a default is supplied. `RecordForm` places declared required fields first, with optional fields behind the shared disclosure. Standards validators enforce conditional requirements when saving. `RecordTable` uses the same field definitions for sorting, grouping and filters. A schema cannot silently accept undeclared fields.

Use `decodeField` for a field, `validateRecord` for a whole record, and core collection methods for persistence. Keep exact integer/decimal values as strings across messages and JSON serialization. Timezone-aware timestamps can retain microseconds in storage; the generic date/time input edits at second precision. A calendar date must never be implicitly interpreted as midnight UTC.

Calendar events and reminders additionally declare the `ical-event` or `ical-alarm` standard. The shared calendar validators enforce UID/DTSTAMP/DTSTART rules, date-versus-date-time values, recurrence, alarm action requirements and relative triggers. Do not replace those standard fields with an incompatible plugin-specific set. Core does not parse Markdown as application data.

Schema versions travel with records. A device may retain and synchronize unknown/newer schemas without loading the plugin. Editing requires its compatible schema. Publish a compatible migration when changing stored fields; disabling or uninstalling code must preserve the user's records and files.

## Reusable types and universal parents

`fieldTypes` exports the SQL scalar inputs and small reusable text variants (multiline, Markdown, email, URL, path, sorting, item reference, and parent). Selection options, list cardinality, defaults and visibility are descriptor parameters, not distinct plugin types. `sharedFieldTemplates` and `fieldTemplate()` provide ordinary descriptors that any plugin can copy. A template's name or origin never changes its input or validation behavior.

```ts
import { field, fieldTypes } from "@jocki/platform/field-types";

const parent = field("belongs_to", "Parent", "text", {
  ...fieldTypes.parent.definition,
  storage: "custom",
  reference: "resources", // any collection; use "tasks" to restrict it
  referenceField: "uid", // standard UID, falling back to the core record ID
  // referenceTable: "<table UUID>", // optional additional restriction
});
```

Parent references hold one identifier. Choose `referenceField: "id"` with `pgType: "uuid"` when a plugin feature expects the core record ID. UID-based references use text because standard UIDs need not be UUIDs. Both work in plugin collections and arbitrary user tables. The shared picker labels accessible items, excludes the current item from its parent choices, and preserves a visible unavailable-reference value when the target is absent. Core rejects new missing or ambiguous links, self-parenting, and cycles across parent fields and collections. Low-level core removal does not cascade. The shared table explicitly includes descendants when the user deletes a row with active reference grouping; its confirmation shows the full count. Unrelated edits to a record with an already missing parent remain possible.

Local relationship checks do not reject otherwise valid signed history because another device has not received the target yet. Concurrent offline hierarchy edits may require the user to resolve a cycle after synchronization; the core does not discard either device's data. `referenceValue`, `referenceMatches`, and `recordValues` are available from `@jocki/platform/core/field-references` in browser and native plugin modules.

Every type uses `FieldInput` directly inside table cells and board cards. JSON syntax errors block saving; exact decimals and large integers remain strings. Generated and view-only fields are displayed without editable inputs. No record-edit dialog is involved.


## Selection and list controls

Use `FieldInput` for every field, including defaults. A single selection uses a dropdown; multiple selections use searchable shadcn combobox chips from the declared typed `options`. Multiple values use the same chips with a Create-only menu. Column options also use Create-only chips for both single and multiple selections. Values remain typed JSON data: integer chips are numbers, boolean chips are booleans, JSON chips retain their structure, and exact decimals/bigints remain strings. Free lists allow repeated values; selection options are unique.

The reusable `ValueCombobox`, `parseChipValue`, and `valueLabel` exports are available from `@jocki/ui/value-combobox`. Supply `options` for selection or a `create(text)` parser for Create-only mode. Pass controlled `value`/`onChange`, count limits, and a label. `onPendingChange` reports uncreated input; custom save handlers must block saving while it is true. `FieldInput` also sets native validity and reports `onDraftChange` so shared tables/forms cannot silently discard uncreated input. Invalid creation uses the central notification system and retains the text for correction.

Keep values controlled by the shared table draft and optimistic collection layer. Chip changes do not persist independently; the normal save, pending sync indicator, rollback, and discard behavior applies. Replacing a saved/draft value updates the chips and clears stale search text.

## Markdown

Use `field("notes", "Notes", "text", fieldTypes.markdown.definition)` for a single Markdown value. It stores the original Markdown text with `control: "markdown"` and `inputMode: "single"`; arrays and selection modes are not supported. It is available in every shared column editor without a plugin-specific template.

`FieldInput` renders [Atomic Editor](https://github.com/kenforthewin/atomic-editor) directly in the cell, including column defaults, without an edit/preview toolbar. The field grows with its content and follows the app theme. Shared tables render noneditable Markdown with the same component in reading mode, with task-checkbox writes also blocked. Changes use the existing row draft, save/cancel, optimistic update and sync-status flow. Incoming values and rollbacks update the live editor without emitting another local edit. Plugins should use the shared components rather than creating a separate Markdown persistence path.
