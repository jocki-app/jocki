import { z } from "zod";
import { CSDBDraft, CSDBDatabase, parseCSDB } from "./csdb";
import type {
  MergeOptions,
  MergePart,
  MergeReport,
} from "@csvdatabase/csdb/portable";
export const csdbMergeParts: MergePart[] = [
  "data",
  "columns",
  "types",
  "comments",
  "visibility",
  "formats",
  "defaults",
  "required",
  "primary_key",
  "unique",
  "foreign_keys",
  "constraints",
  "indexes",
  "computed_fields",
];
export const mergeOptionsSchema = z
  .object({
    include: z
      .array(z.enum(csdbMergeParts as [MergePart, ...MergePart[]]))
      .optional(),
    nulls: z.enum(["preserve", "defaults"]).optional(),
    conflicts: z.enum(["error", "skip", "update", "replace"]).optional(),
    metadata_conflicts: z.enum(["error", "source", "target"]).optional(),
    missing_tables: z.enum(["error", "create", "skip"]).optional(),
    missing_columns: z.enum(["error", "add", "ignore"]).optional(),
    missing_foreign_keys: z.enum(["error", "drop", "null"]).optional(),
    tables: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              source: z.string(),
              target: z.string().optional(),
              columns: z.array(z.string()).optional(),
              rows: z
                .object({
                  indices: z.array(z.number().int().nonnegative()).optional(),
                  keys: z.array(z.array(z.unknown())).optional(),
                  where: z
                    .custom<import("@csvdatabase/csdb/portable").Expr>(
                      (value) => !!value && typeof value === "object",
                    )
                    .optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
  })
  .strict();
export const csdbImportProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    view: z.enum(["table", "form", "autosave"]),
    map_single_table: z.boolean(),
    options: mergeOptionsSchema,
  })
  .strict();
export type CSDBImportProfile = Omit<
  z.infer<typeof csdbImportProfileSchema>,
  "options"
> & { options: MergeOptions };
export interface CSDBImportSettings {
  default_profile: string;
  profiles: CSDBImportProfile[];
}
const settingsSchema = z
  .object({
    default_profile: z.string(),
    profiles: z.array(csdbImportProfileSchema).min(1),
  })
  .strict()
  .superRefine((settings, context) => {
    if (
      new Set(settings.profiles.map((profile) => profile.id)).size !==
        settings.profiles.length ||
      !settings.profiles.some(
        (profile) => profile.id === settings.default_profile,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Choose a default profile and unique profile IDs",
      });
  });
export function defaultCSDBImportSettings(): CSDBImportSettings {
  return {
    default_profile: "default",
    profiles: [
      {
        id: "default",
        name: "Default",
        view: "table",
        map_single_table: true,
        options: {
          include: ["data", "visibility"],
          nulls: "defaults",
          conflicts: "error",
          metadata_conflicts: "target",
          missing_tables: "create",
          missing_columns: "add",
          missing_foreign_keys: "error",
        },
      },
    ],
  };
}
export function readCSDBImportSettings(plugin: unknown): CSDBImportSettings {
  const configuration = (plugin as { configuration?: unknown } | undefined)
    ?.configuration;
  return configuration === undefined
    ? defaultCSDBImportSettings()
    : (settingsSchema.parse(configuration) as CSDBImportSettings);
}
export function validateCSDBImportSettings(value: unknown): CSDBImportSettings {
  return settingsSchema.parse(value) as CSDBImportSettings;
}
/** Merge in a private SDK draft and publish once, including multi-file imports. */
export function mergeCSDBImport(
  destination: string,
  sources: string[],
  profile: CSDBImportProfile,
) {
  const db = new CSDBDraft(destination),
    targetTables = new Set(db.document.tableOrder),
    reports: MergeReport[] = [],
    changed = new Map<string, Set<number>>();
  for (const source of sources) {
    const parsed = parseCSDB(source),
      options = structuredClone(profile.options);
    if (
      profile.map_single_table &&
      !options.tables &&
      targetTables.size === 1 &&
      parsed.tables.size === 1
    )
      options.tables = [
        { source: parsed.tableOrder[0], target: [...targetTables][0] },
      ];
    const report = db.merge(parsed, options);
    reports.push(report);
    for (const table of report.tables) {
      targetTables.add(table.target);
      const rows = changed.get(table.target) ?? new Set<number>();
      for (const index of table.rows) rows.add(index);
      changed.set(table.target, rows);
    }
  }
  return {
    text: db.toString(),
    reports,
    rows: [...changed].flatMap(([table, indices]) =>
      [...indices].map((index) => ({ table, index })),
    ),
  };
}

/** Resolve template defaults exactly once, through native SDK merge commands. */
export function instantiateCSDBTemplate(source: string) {
  const document = parseCSDB(source);
  const empty = structuredClone(document);
  for (const table of empty.tables.values()) table.rows = [];
  const db = new CSDBDatabase(empty);
  db.merge(document, { nulls: "defaults" });
  return db.toString();
}
