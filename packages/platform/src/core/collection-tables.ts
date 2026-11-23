import {
  field,
  validateRecord,
  decodeField,
  type Field,
  type RecordSchema,
  type Value,
} from "../field-types";
import { tableFields } from "./dynamic-fields";
import { invariant } from "./errors";

export const standardTableCollections = [
  "tasks",
  "calendar",
  "reminders",
  "time",
  "track",
  "mail",
  "workflows",
];
export const tableSystemFields = new Set(["table_id", "custom_fields"]);
const standards: Record<
  string,
  { name: string; url?: string; required: string[] }
> = {
  tasks: {
    name: "iCalendar VTODO",
    url: "https://www.rfc-editor.org/rfc/rfc5545#section-3.6.2",
    required: ["uid", "dtstamp"],
  },
  calendar: {
    name: "iCalendar VEVENT (without METHOD)",
    url: "https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1",
    required: ["uid", "dtstamp", "dtstart"],
  },
  reminders: {
    name: "iCalendar VALARM",
    url: "https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6",
    required: ["action", "trigger"],
  },
  time: { name: "Time interval runtime", required: ["started_at"] },
  track: { name: "General tracking record", required: [] },
  mail: {
    name: "RFC 5322 (drafts may be incomplete)",
    url: "https://www.rfc-editor.org/rfc/rfc5322#section-3.6",
    required: [],
  },
};
/** Behavioral inputs, excluding passive metadata and interchange-only properties. */
const builtinFeatures: Record<string, readonly string[]> = {
  track: ["title", "started_at", "ended_at"],
  time: [
    "title",
    "started_at",
    "ended_at",
    "paused_ms",
    "paused_at",
    "target_seconds",
    "kind",
  ],
  tasks: ["title", "status"],
  calendar: [
    "dtstart",
    "dtend",
    "duration",
    "timezone",
    "summary",
    "location",
    "rrule",
    "exdates",
    "rdates",
    "recurrence_id",
  ],
  reminders: [
    "action",
    "trigger",
    "description",
    "summary",
    "attendees",
    "parent_id",
    "related",
    "mail_account_id",
    "repeat",
    "duration",
    "enabled",
    "acknowledged_at",
    "snoozed_until",
  ],
  mail: [
    "account_id",
    "mailbox",
    "subject",
    "from",
    "to",
    "cc",
    "bcc",
    "body",
    "html",
    "message_id",
    "provider_uid",
    "uid_validity",
    "status",
    "read",
    "flags",
    "in_reply_to",
    "references",
    "send_operation_id",
    "provider_deleted",
    "attachments",
  ],
  workflows: [
    "name",
    "graph",
    "target_device_id",
    "enabled",
    "published_version",
    "trigger_kind",
    "schedule_seconds",
    "schedule_start",
    "catch_up",
    "event_type",
    "allow_trusted_code",
    "offline_policy",
    "dispatch_timeout_seconds",
  ],
};
export function pluginFeatureFields(schema: RecordSchema): Field[] {
  const ids = schema.featureFields ?? builtinFeatures[schema.id] ?? [];
  return schema.fields.filter(
    (f) =>
      ids.includes(f.id) &&
      !f.required &&
      !tableSystemFields.has(f.id) &&
      f.id !== "item_id",
  );
}
export function tableStandard(schema: RecordSchema) {
  return (
    standards[schema.id] ?? {
      name: "Plugin contract",
      required: schema.fields.filter((f) => f.required).map((f) => f.id),
    }
  );
}
/** Require the shared table field contract for table-backed plugin collections. */
export function withCollectionTables(schema: RecordSchema): RecordSchema {
  if (!schema.tables && !standardTableCollections.includes(schema.id))
    return schema;
  const standard = standards[schema.id];
  const fields = schema.fields
    .filter((f) => !tableSystemFields.has(f.id))
    .map((f) =>
      standard
        ? {
            ...f,
            required: standard.required.includes(f.id),
            nullable: !standard.required.includes(f.id),
          }
        : f,
    );
  if (["tasks", "calendar"].includes(schema.id)) {
    for (const [id, label, pgType, generated] of [
      ["uid", "UID", "text", "uuid"],
      ["dtstamp", "DTSTAMP", "timestamp with time zone", "timestamp"],
    ] as const) {
      const existing = fields.find((f) => f.id === id);
      if (existing) existing.generated = generated;
      else
        fields.push(
          field(id, label, pgType, {
            required: true,
            nullable: false,
            generated,
          }),
        );
    }
    const sharedPresets = [
      field("classification", "Classification", "text", {
        choices: ["PUBLIC", "PRIVATE", "CONFIDENTIAL"],
      }),
      field("created", "Created", "timestamp with time zone"),
      field("last_modified", "Last modified", "timestamp with time zone"),
      field("location", "Location"),
      field("organizer", "Organizer", "text", { control: "email" }),
      field("geo", "Geographic position", "jsonb"),
      field("sequence", "Sequence", "integer", { min: 0 }),
      field("url", "URL", "text", { control: "url" }),
      field("rrule", "Recurrence rule"),
      field("recurrence_id", "Recurrence ID"),
      field("attachments", "Attachments", "text", { array: true }),
      field("attendees", "Attendees", "text", { array: true }),
      field("categories", "Categories", "text", { array: true }),
      field("comments", "Comments", "text", { array: true }),
      field("contacts", "Contacts", "text", { array: true }),
      field("related_to", "Related items", "text", { array: true }),
      field("resources", "Resources", "text", { array: true }),
      field("exdates", "Excluded recurrence dates", "jsonb"),
      field("rdates", "Additional recurrence dates", "jsonb"),
      field("request_status", "Request status", "text", { array: true }),
      ...(schema.id === "tasks"
        ? [
            field("dtstart", "Start"),
            field("duration", "Duration", "interval"),
            field("completed", "Completed", "timestamp with time zone"),
            field("percent_complete", "Percent complete", "integer", {
              min: 0,
              max: 100,
            }),
          ]
        : [field("priority", "Priority", "integer", { min: 0, max: 9 })]),
    ];
    for (const preset of sharedPresets)
      if (!fields.some((f) => f.id === preset.id)) fields.push(preset);
  }
  if (schema.id === "reminders" && !fields.some((f) => f.id === "attachments"))
    fields.push(field("attachments", "Attachments", "text", { array: true }));
  if (schema.id === "mail")
    for (const preset of [
      field("sent_at", "Date", "timestamp with time zone"),
      field("sender", "Sender", "text", { control: "email" }),
      field("reply_to", "Reply-To", "text", { array: true }),
      field("comments", "Comments"),
      field("keywords", "Keywords", "text", { array: true }),
    ])
      if (!fields.some((f) => f.id === preset.id)) fields.push(preset);
  return {
    ...schema,
    tables: true,
    fields: [
      ...fields.filter((f) => f.id !== "item_id"),
      field("item_id", "Item ID", "uuid", {
        required: true,
        nullable: false,
        generated: "uuid",
        visibility: "viewable",
        reference: "items",
        control: "reference",
      }),
      field("table_id", "Table", "uuid"),
      field("custom_fields", "Custom fields", "jsonb", { default: {} }),
    ],
  };
}
export function collectionColumns(
  schema: RecordSchema,
  value?: unknown,
): Field[] {
  const fields = schema.fields.filter((f) => !tableSystemFields.has(f.id));
  if (value === undefined) return fields;
  const columns = tableFields(value);
  const required = [...tableStandard(schema).required, "item_id"];
  for (const id of required)
    invariant(
      columns.some((f) => f.id === id),
      "REQUIRED_COLUMN",
      `The standard requires ${id}`,
    );
  for (const column of columns) {
    invariant(
      !tableSystemFields.has(column.id),
      "RESERVED_COLUMN",
      "This column is reserved by core",
    );
    const base = fields.find((f) => f.id === column.id);
    if (base && (required.includes(base.id) || column.storage !== "custom"))
      invariant(
        (
          [...new Set([...Object.keys(base), ...Object.keys(column)])] as Array<
            keyof Field
          >
        )
          .filter(
            (key) =>
              !["label", "description", "visibility", "scope"].includes(key),
          )
          .every(
            (key) => JSON.stringify(column[key]) === JSON.stringify(base[key]),
          ),
        "STANDARD_COLUMN",
        "Standard column types and requirements cannot be changed",
      );
  }
  return columns;
}
/** Explicit plugin role -> column mappings. Column names carry no behavior. */
export function fieldBindings(
  schema: RecordSchema,
  columns: unknown,
  value: unknown = {},
) {
  invariant(
    value != null && typeof value === "object" && !Array.isArray(value),
    "INVALID_BINDING",
    "Feature fields must be a mapping",
  );
  const fields = collectionColumns(schema, columns);
  const bindings = value as Record<string, string>;
  const used = new Set<string>();
  for (const [role, id] of Object.entries(bindings)) {
    const target = schema.fields.find(
      (f) => f.id === role && !tableSystemFields.has(f.id) && !f.required,
    );
    const source = fields.find((f) => f.id === id);
    invariant(
      target &&
        source &&
        target.pgType === source.pgType &&
        target.array === source.array,
      "INVALID_BINDING",
      `Choose a compatible column for ${role}`,
    );
    invariant(
      !used.has(id),
      "INVALID_BINDING",
      "A column can supply only one feature field",
    );
    used.add(id);
  }
  return bindings;
}
export function templateValues(
  schema: RecordSchema,
  columns: unknown,
  input: Record<string, Value>,
  previous: Record<string, Value> = {},
  bindingsValue: unknown = {},
) {
  const data = { ...input };
  const supplied = input.custom_fields ?? {};
  invariant(
    typeof supplied === "object" && !Array.isArray(supplied),
    "VALIDATION_FAILED",
    "Custom fields must be an object",
  );
  const custom = { ...(supplied as Record<string, Value>) };
  const fields = collectionColumns(schema, columns);
  for (const [role, id] of Object.entries(
    fieldBindings(schema, columns, bindingsValue),
  )) {
    const source = fields.find((f) => f.id === id)!;
    const target = schema.fields.find((f) => f.id === role)!;
    const isCustom =
      source.storage === "custom" || !schema.fields.some((f) => f.id === id);
    if (!isCustom && id === role) continue;
    const oldValue = isCustom
      ? (previous.custom_fields as Record<string, Value> | undefined)?.[id]
      : previous[id];
    const sourceValues = isCustom ? custom : input;
    const hasSource = Object.hasOwn(sourceValues, id);
    let value = hasSource
      ? sourceValues[id]
      : ((source.default as Value | undefined) ?? null);
    // A canonical API write can satisfy a required mapped column. Explicit custom edits win.
    if (
      Object.hasOwn(input, role) &&
      (!hasSource ||
        (JSON.stringify(input[role]) !== JSON.stringify(previous[role]) &&
          JSON.stringify(sourceValues[id]) === JSON.stringify(oldValue)))
    ) {
      value = decodeField(source, input[role]);
      if (isCustom) custom[id] = value;
      else data[id] = value;
    }
    if (value !== undefined) data[role] = decodeField(target, value);
  }
  data.custom_fields = customValues(schema, columns, custom, previous);
  return data;
}
export function customValues(
  schema: RecordSchema,
  columns: unknown,
  values: unknown,
  original: Record<string, Value> = {},
) {
  const fields = collectionColumns(schema, columns).filter(
    (f) =>
      f.storage === "custom" || !schema.fields.some((base) => base.id === f.id),
  );
  const stored = values == null ? {} : (values as Record<string, Value>);
  invariant(
    typeof stored === "object" && !Array.isArray(stored),
    "VALIDATION_FAILED",
    "Custom fields must be an object",
  );
  const selected = Object.fromEntries(
    fields
      .map((f) => [
        f.id,
        Object.prototype.hasOwnProperty.call(stored, f.id)
          ? stored[f.id]
          : undefined,
      ])
      .filter(([, v]) => v !== undefined),
  );
  // Removing a column hides it; it must not erase previously stored values.
  return {
    ...stored,
    ...validateRecord({ ...schema, fields, validate: undefined }, selected),
  };
}
export function generatedValues(
  schema: RecordSchema,
  input: unknown,
  previous?: Record<string, Value>,
) {
  invariant(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "VALIDATION_FAILED",
    "Expected record fields",
  );
  const data = { ...(input as Record<string, Value>) };
  for (const f of schema.fields)
    if (f.generated && data[f.id] == null)
      data[f.id] =
        previous?.[f.id] ??
        (f.generated === "uuid"
          ? crypto.randomUUID()
          : new Date().toISOString());
  return data;
}
