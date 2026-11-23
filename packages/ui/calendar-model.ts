import { parseISO, isValid, addDays } from "date-fns";
import type { Field, Value } from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";

export function calendarFields(fields: Field[]): Field[] {
  return fields.filter(
    (f) =>
      !f.array &&
      f.visibility !== "hidden" &&
      [
        "date",
        "timestamp with time zone",
        "timestamp without time zone",
      ].includes(f.pgType),
  );
}
export function calendarDate(value: Value | undefined) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T| |$)/.test(value))
    return undefined;
  const date = parseISO(value);
  return isValid(date) ? date : undefined;
}
export function calendarEntries(
  rows: ResourceRecord[],
  field: Field,
  now = new Date(),
) {
  return rows.flatMap((row) => {
    const start = calendarDate(row.data[field.id]);
    if (!start) return [];
    const endId =
      field.id === "started_at"
        ? "ended_at"
        : field.id === "dtstart"
          ? "dtend"
          : undefined;
    const end =
      (endId && calendarDate(row.data[endId])) ||
      (field.pgType === "date"
        ? addDays(start, 1)
        : field.id === "started_at" && +start < +now
          ? now
          : start);
    return [
      {
        row,
        start,
        end: +end >= +start ? end : start,
        allDay: field.pgType === "date",
      },
    ];
  });
}
