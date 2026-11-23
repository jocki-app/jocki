import type { Value } from "@jocki/platform/field-types";
import { CSDBDraft, csdbComparable } from "../core/vaults/csdb";
export interface InputDraft {
  text?: string;
  pending?: boolean;
  value?: string;
}
export interface CSDBFormBuffer {
  key: string;
  table: string;
  index: number;
  values: Record<string, Value>;
  baseline: string;
  pending: boolean;
  optional: string[];
  inputs: Record<string, InputDraft>;
}
export interface CSDBFormSession {
  table?: string;
  index?: number;
  token?: string;
  buffer?: CSDBFormBuffer;
}
/** Prepare the row through the SDK; never save or discard another tab's changes. */
export function applyCSDBFormBuffer(value: string, buffer: CSDBFormBuffer) {
  if (Object.values(buffer.inputs).some((input) => input.pending))
    throw Error("Finish entering the field value before applying this row");
  const db = new CSDBDraft(value),
    table = db.document.tables.get(buffer.table);
  if (!table) throw Error("This table is no longer available");
  const data = Object.fromEntries(
    Object.keys(table.schema.columns).map((column) => [
      column,
      buffer.values[column] ?? null,
    ]),
  );
  let index = buffer.index;
  if (index < 0) {
    index = table.rows.length;
    db.table(table.name).insert(data);
  } else {
    if (
      !table.rows[index] ||
      csdbComparable(table.rows[index]) !== buffer.baseline
    )
      throw Error(
        "This row changed while the form was being edited. Reload it before applying changes.",
      );
    db.execute({
      kind: "update",
      table: table.name,
      row_indices: [index],
      set: data,
    });
  }
  return { text: db.toString(), index };
}
