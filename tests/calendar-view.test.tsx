// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { field } from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { calendarFields, calendarEntries } from "../packages/ui/calendar-model";
import {
  availableViewModes,
  normalizeView,
} from "../packages/ui/collection-view-model";
import { CollectionView } from "../packages/ui/collection-view";
const fields = [
  field("title", "Title"),
  field("date", "Date", "date"),
  field("when", "When", "timestamp with time zone"),
];
const schema = {
  id: "test",
  pluginId: "test",
  name: "Entries",
  version: 1,
  fields,
};
const row = (id: string, data: ResourceRecord["data"]) =>
  ({ id, data }) as ResourceRecord;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});
it("automatically offers calendar views only for usable date descriptors", () => {
  expect(availableViewModes(fields)).toEqual(
    expect.arrayContaining(["list", "week", "month"]),
  );
  expect(availableViewModes([fields[0]])).not.toContain("week");
  expect(
    calendarFields([
      field("times", "Times", "date", { array: true }),
      field("hidden", "Hidden", "date", { visibility: "hidden" }),
      field("time", "Time", "time without time zone"),
    ]),
  ).toEqual([]);
  expect(
    normalizeView({ mode: "month", dateField: "date" }, schema),
  ).toMatchObject({ mode: "month", dateField: "date" });
  expect(
    normalizeView({ mode: "month" }, { ...schema, fields: [fields[0]] }).mode,
  ).toBe("short-table");
});
it("rejects missing/invalid dates and handles date-only and point-in-time records", () => {
  const rows = [
    row("ok", { date: "2026-10-19" }),
    row("empty", {}),
    row("bad", { date: "2026-02-30" }),
  ];
  const entries = calendarEntries(rows, fields[1]);
  expect(entries.map((e) => e.row.id)).toEqual(["ok"]);
  expect(entries[0].end.getDate()).toBe(20);
  expect(
    calendarEntries(
      [row("epoch", { when: "1970-01-01T00:00:00Z" })],
      fields[2],
    )[0].start.getTime(),
  ).toBe(0);
});
it("renders the shared count, hidden count and date selector, with zero-hidden omitted", async () => {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const rows = [
    row("visible", { title: "Dated record", date }),
    row("hidden", { title: "Undated record" }),
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function View({ records = rows }: { records?: ResourceRecord[] }) {
    const [state, setState] = useState(
      normalizeView({ mode: "month", dateField: "date" }, schema),
    );
    return (
      <CollectionView
        schema={schema}
        rows={records}
        state={state}
        onChange={(patch) => setState((s) => ({ ...s, ...patch }))}
      />
    );
  }
  await act(async () => root!.render(<View />));
  expect(host.textContent).toContain("1 entry · 1 hidden");
  expect(host.textContent).toContain("Dated record");
  expect(host.textContent).not.toContain("Undated record");
  expect(host.querySelector('[aria-label="Calendar date field"]')).toBeTruthy();
  await act(async () => root!.render(<View records={[rows[0]]} />));
  expect(host.textContent).not.toContain("hidden");
  expect(host.textContent).toContain("1 entry");
});
