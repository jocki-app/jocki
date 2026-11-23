import type { Field, Value } from "../field-types";
import type { ResourceRecord } from "../plugin-sdk";
import { invariant } from "./errors";

export function recordValues(row: ResourceRecord): Record<string, Value> {
  return row.collection === "table_rows"
    ? (row.data.values as Record<string, Value>)
    : {
        ...row.data,
        ...((row.data.custom_fields as Record<string, Value>) ?? {}),
      };
}
/** Every resource has a core UUID; standards may additionally supply their own UID. */
export function referenceValue(
  row: ResourceRecord,
  field: Field,
): Value | undefined {
  const key = field.referenceField ?? "id";
  const uid = recordValues(row).uid;
  return key === "uid" && typeof uid === "string" && uid ? uid : row.id;
}
export function referenceMatches(row: ResourceRecord, field: Field) {
  return (
    !row.deletedAt &&
    (!field.reference ||
      field.reference === "resources" ||
      row.collection === field.reference) &&
    (!field.referenceTable || row.data.table_id === field.referenceTable)
  );
}
/** Validate local edits, never depend on replication arrival order to accept signed history. */
export function validateReferences(
  candidate: ResourceRecord,
  previous: ResourceRecord | undefined,
  records: ResourceRecord[],
  fieldsFor: (row: ResourceRecord) => Field[],
) {
  const rows = records.filter((r) => r.id !== candidate.id).concat(candidate);
  const resolve = (f: Field, value: Value) =>
    rows.filter(
      (r) => referenceMatches(r, f) && referenceValue(r, f) === value,
    );
  const values = recordValues(candidate),
    old = previous ? recordValues(previous) : {};
  const changed = fieldsFor(candidate).filter(
    (f) =>
      f.relationship &&
      JSON.stringify(values[f.id]) !== JSON.stringify(old[f.id]),
  );
  for (const f of changed) {
    for (const value of [values[f.id]].flat()) {
      if (value == null || value === "") continue;
      const matches = resolve(f, value);
      invariant(
        matches.length === 1,
        "INVALID_REFERENCE",
        `${f.label}: select one available item with a unique identifier`,
      );
      if (f.relationship !== "parent") continue;
      const visit = (row: ResourceRecord, path: Set<string>) => {
        invariant(
          !path.has(row.id),
          "PARENT_CYCLE",
          "A parent reference cannot contain itself or a cycle",
        );
        const next = new Set(path).add(row.id);
        for (const parent of fieldsFor(row).filter(
          (field) => field.relationship === "parent",
        ))
          for (const link of [recordValues(row)[parent.id]].flat()) {
            if (link == null || link === "") continue;
            for (const target of resolve(parent, link)) visit(target, next);
          }
      };
      visit(matches[0], new Set([candidate.id]));
    }
  }
}
