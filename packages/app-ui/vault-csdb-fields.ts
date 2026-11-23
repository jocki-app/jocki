import {
  field,
  type Field,
  type PgType,
  type Value,
  fieldTypes,
} from "@jocki/platform/field-types";
import {
  resolveType,
  type Table,
  type ColumnType,
  type TableSchema,
} from "@csvdatabase/csdb/portable";

const nativeToPG: Record<string, PgType> = {
  text: "text",
  varchar: "character varying",
  integer: "integer",
  bigint: "bigint",
  real: "double precision",
  numeric: "numeric",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp without time zone",
  json: "jsonb",
  enum: "text",
  array: "jsonb",
};
const pgToNative: Partial<Record<PgType, string>> = {
  text: "text",
  "character varying": "varchar",
  integer: "integer",
  bigint: "bigint",
  "double precision": "real",
  numeric: "numeric",
  boolean: "boolean",
  date: "date",
  "timestamp without time zone": "timestamp",
  jsonb: "json",
};
export const csdbFieldTypes: typeof fieldTypes = Object.fromEntries(
  Object.entries(pgToNative).map(([pg, type]) => [
    pg,
    { label: type, definition: { pgType: pg as PgType } },
  ]),
);
csdbFieldTypes.enum = {
  label: "enum",
  definition: {
    pgType: "text",
    control: "select",
  } as (typeof fieldTypes)[string]["definition"],
};
csdbFieldTypes.reference = fieldTypes.reference;
csdbFieldTypes.parent = fieldTypes.parent;
export function uiValue(value: unknown): Value {
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(uiValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, uiValue(value)]),
    );
  return value as Value;
}
export function csdbFields(table: Table, tasks = false): Field[] {
  const presentation = (table.schema.comments["jocki.fields"] ??
    {}) as Record<string, Partial<Field>>;
  return Object.entries(table.schema.columns).map(([id, type]) => {
    const resolved = resolveType(
      type,
      table.types,
      table.schema.schema,
    ) as Exclude<ColumnType, string>;
    const array = resolved.type === "array",
      scalar = array
        ? (resolved.items as Exclude<ColumnType, string>)
        : resolved;
    const options = (scalar.options ?? resolved.options)?.map(uiValue);
    const display = presentation[id] ?? {};
    const foreignKey = table.schema.foreign_keys.find((key) =>
      key.columns.includes(id),
    );
    const visibility = table.schema.visibility[id];
    const supportedVisibility = [
      "editable",
      "viewable",
      "hidden",
      "addable",
    ].includes(visibility)
      ? (visibility as Field["visibility"])
      : undefined;
    const generated =
      (
        table.schema.comments["jocki.generated"] as
          Record<string, Field["generated"]> | undefined
      )?.[id] ??
      (tasks
        ? ({ uid: "uuid", dtstamp: "timestamp" } as const)[
            id as "uid" | "dtstamp"
          ]
        : undefined);
    const definition = field(
      /^[a-z][a-z0-9_]*$/.test(id) ? id : "attribute",
      display.label ??
        (["id", "uid", "dtstamp"].includes(id)
          ? id.toUpperCase()
          : id.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase())),
      nativeToPG[scalar.type],
      {
        description: display.description,
        generated:
          generated ??
          (id === "id" && scalar.type === "text" ? "uuid" : undefined),
        control: foreignKey
          ? "reference"
          : (display.control ??
            (scalar.type === "enum" ? "select" : undefined)),
        visibility:
          supportedVisibility ??
          (id === "id" && scalar.type === "text"
            ? "hidden"
            : generated
              ? "viewable"
              : "editable"),
        reference: foreignKey?.references.table,
        referenceField:
          foreignKey?.references.columns[foreignKey.columns.indexOf(id)],
        referenceLabelField: foreignKey?.label_field,
        relationship: foreignKey
          ? foreignKey.references.table === table.name &&
            (foreignKey.relationship === "parent" || id === "parent_id")
            ? "parent"
            : "reference"
          : undefined,
        required: table.schema.required.includes(id),
        nullable: !table.schema.required.includes(id),
        array,
        inputMode: array
          ? options
            ? "multiselect"
            : "list"
          : options
            ? "select"
            : "single",
        options,
        ...(resolved.minItems !== undefined
          ? { minItems: resolved.minItems as number }
          : {}),
        ...(resolved.maxItems !== undefined && resolved.maxItems !== 0
          ? { maxItems: resolved.maxItems as number }
          : {}),
        ...(scalar.length !== undefined
          ? { length: scalar.length as number }
          : {}),
        ...(Object.hasOwn(table.schema.defaults, id)
          ? { default: uiValue(table.schema.defaults[id]) }
          : {}),
      },
    );
    definition.id = id;
    return definition;
  });
}
export function csdbColumnType(field: Field): ColumnType {
  const native = pgToNative[field.pgType];
  if (!native) throw Error(`CSDB has no native ${field.pgType} type.`);
  const options = field.options ?? field.choices;
  const scalar: Exclude<ColumnType, string> = {
    type: field.control === "select" && native === "text" ? "enum" : native,
  };
  if (options !== undefined) scalar.options = options;
  if (field.length !== undefined) scalar.length = field.length;
  if (field.array)
    return {
      type: scalar.type,
      inputMode: "array",
      ...(scalar.options ? { options: scalar.options } : {}),
      ...(scalar.length ? { length: scalar.length } : {}),
      ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
      ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
      ...(field.inputMode === "multiselect" ? { uniqueItems: true } : {}),
    };
  return { ...scalar, inputMode: "enum" };
}
export function csdbTableDefinition(
  table: Table,
  fields: Field[],
): TableSchema {
  const previous = csdbFields(table);
  const dataShape = (f: Field) =>
    JSON.stringify([
      f.pgType,
      f.array,
      f.inputMode,
      f.options,
      f.length,
      f.minItems,
      f.maxItems,
    ]);
  const columns = Object.fromEntries(
    fields.map((f) => {
      const prior = previous.find((p) => p.id === f.id);
      return [
        f.id,
        prior && dataShape(prior) === dataShape(f)
          ? table.schema.columns[f.id]
          : csdbColumnType(f),
      ];
    }),
  );
  return {
    ...table.schema,
    columns,
    ...(table.schema.formats
      ? {
          formats: Object.fromEntries(
            Object.entries(table.schema.formats).filter(([column]) =>
              fields.some(
                (field) =>
                  field.id === column &&
                  (field.pgType === "date" ||
                    field.pgType.startsWith("timestamp")),
              ),
            ),
          ),
        }
      : {}),
    required: fields.filter((f) => f.required).map((f) => f.id),
    defaults: Object.fromEntries(
      fields
        .filter((f) => f.default !== undefined)
        .map((f) => [f.id, f.default]),
    ),
    visibility: Object.fromEntries(
      fields.flatMap((f) => {
        if (f.visibility === previous.find((p) => p.id === f.id)?.visibility)
          return table.schema.visibility[f.id] === undefined
            ? []
            : [[f.id, table.schema.visibility[f.id]]];
        return f.visibility === undefined ? [] : [[f.id, f.visibility]];
      }),
    ),
    foreign_keys: [
      ...table.schema.foreign_keys.filter(
        (fk) =>
          fk.columns.length > 1 &&
          fk.columns.every((column) => Object.hasOwn(columns, column)),
      ),
      ...fields
        .filter(
          (f) =>
            f.reference &&
            !table.schema.foreign_keys.some(
              (fk) => fk.columns.length > 1 && fk.columns.includes(f.id),
            ),
        )
        .map((f) => {
          const priorField = previous.find((field) => field.id === f.id);
          const priorKey = table.schema.foreign_keys.find(
            (fk) => fk.columns.length === 1 && fk.columns[0] === f.id,
          );
          const { label_field: _label, ...existing } = priorKey ?? {};
          return {
            ...existing,
            name: priorKey?.name ?? `${table.schema.name}_${f.id}_fkey`,
            columns: [f.id],
            references: {
              table: f.reference!,
              columns: [f.referenceField ?? "id"],
            },
            ...(f.referenceLabelField
              ? {
                  label_field:
                    f.reference === table.name &&
                    !Object.hasOwn(columns, f.referenceLabelField)
                      ? "id"
                      : f.referenceLabelField,
                }
              : {}),
            ...(priorKey && f.relationship === priorField?.relationship
              ? {}
              : { relationship: f.relationship ?? "reference" }),
          };
        }),
    ],
    comments: {
      ...table.schema.comments,
      "jocki.fields": Object.fromEntries(
        fields.map((f) => [
          f.id,
          Object.fromEntries(
            Object.entries({
              label: f.label,
              description: f.description,
              control: f.control,
            }).filter(([, v]) => v !== undefined),
          ),
        ]),
      ),
    },
  };
}

export const taskColumnTemplates: Field[] = [
  field("title", "Title"),
  field("status", "Status", "text", {
    control: "select",
    inputMode: "select",
    options: ["open", "in-progress", "done", "cancelled"],
    default: "open",
  }),
  field("parent_id", "Parent", "text", {
    control: "reference",
    reference: "public.tasks",
    referenceField: "id",
    referenceLabelField: "title",
    relationship: "parent",
  }),
  field("body", "Notes", "text", { control: "textarea" }),
  field("description", "Description", "text", { control: "textarea" }),
  field("sort", "Sorting", "text", { control: "sorting" }),
  field("priority", "Priority", "integer"),
  field("tags", "Tags", "text", { array: true, inputMode: "list" }),
  field("due_date", "Due date", "date"),
  field("due_at", "Due time", "timestamp without time zone"),
];

/** All native target tables feed the same typed reference inputs. */
export function csdbReferences(
  document: import("@csvdatabase/csdb/portable").CSDBDocument,
) {
  return Object.fromEntries(
    [...document.tables].map(([name, table]) => [
      name,
      table.rows.map((row, index) => ({
        id: String(row.id ?? index),
        uid: row.uid == null ? undefined : String(row.uid),
        label: String(row.title ?? row.name ?? row.id ?? index + 1),
        values: uiValue(row) as Record<string, Value>,
      })),
    ]),
  );
}
