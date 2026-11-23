// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VaultCollectionEditor } from "../packages/app-ui/vault-collection-editor";
import { CSDBDraft, newCSDB, parseCSDB } from "../packages/core/vaults/csdb";
import { contentTypes } from "../packages/core/vaults/content-types";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
it("creates tasks with the required UID and DTSTAMP even without presentation comments", async () => {
  const draft = new CSDBDraft(newCSDB(contentTypes[0]));
  draft.alterTable({
    ...draft.document.tables.get("public.tasks")!.schema,
    comments: {},
  });
  let text = draft.toString();
  await act(async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    root.render(
      <VaultCollectionEditor
        value={text}
        onChange={(next) => {
          text = next;
        }}
        tasks
      />,
    );
  });
  await act(async () =>
    (
      document.querySelector('[aria-label="Add task"]') as HTMLButtonElement
    ).click(),
  );
  const rows = parseCSDB(text).tables.get("public.tasks")!.rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  expect(rows[0].uid).toMatch(/^[0-9a-f-]{36}$/);
  expect(rows[0].dtstamp).toMatch(/^\d{4}-\d\d-\d\dT/);
});

it("defaults tasks to an ordered parent tree with distinct ID references and visible nesting", async () => {
  const db = new CSDBDraft(newCSDB(contentTypes[0]));
  const table = db.document.tables.get("public.tasks")!;
  db.alterTable({
    ...table.schema,
    columns: {
      ...table.schema.columns,
      title: "text",
      parent_id: "text",
      sort: "text",
    },
    foreign_keys: [
      {
        name: "parent",
        columns: ["parent_id"],
        references: { table: "public.tasks", columns: ["id"] },
        label_field: "title",
        relationship: "parent",
      },
    ],
    comments: {
      ...table.schema.comments,
      "jocki.fields": { sort: { control: "sorting" } },
    },
  });
  db.table(table.name).insert([
    {
      id: "leaf",
      uid: "u-leaf",
      dtstamp: "2026-01-01T00:00:00Z",
      title: "Leaf",
      parent_id: "child",
      sort: "0|c:",
    },
    {
      id: "child",
      uid: "u-child",
      dtstamp: "2026-01-01T00:00:00Z",
      title: "Child",
      parent_id: "root",
      sort: "0|b:",
    },
    {
      id: "root",
      uid: "u-root",
      dtstamp: "2026-01-01T00:00:00Z",
      title: "Root",
      parent_id: null,
      sort: "0|a:",
    },
  ]);
  await act(async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    root.render(
      <VaultCollectionEditor
        value={db.toString()}
        onChange={() => {}}
        tasks
        preferences={{ columns: ["title"] }}
      />,
    );
  });
  const rows = [...document.querySelectorAll<HTMLElement>("[data-record-id]")];
  expect(rows.map((row) => row.dataset.recordId)).toEqual([
    "root",
    "child",
    "leaf",
  ]);
  expect(rows.map((row) => row.dataset.recordDepth)).toEqual(["0", "1", "2"]);
  expect(
    rows.map(
      (row) =>
        (row.querySelector('[data-field="title"]') as HTMLElement).style
          .paddingInlineStart,
    ),
  ).toEqual(["8px", "27px", "46px"]);
});
it("changes native CSDB columns through the inline column editor", async () => {
  let text = newCSDB(contentTypes[0]);
  const alter = vi.spyOn(CSDBDraft.prototype, "alterTable");
  function App() {
    const [value, setValue] = useState(text);
    return (
      <VaultCollectionEditor
        value={value}
        onChange={(next) => {
          text = next;
          setValue(next);
        }}
        tasks
        part="columns"
        required={["id", "uid", "dtstamp"]}
      />
    );
  }
  await act(async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    root.render(<App />);
  });
  expect(document.querySelectorAll("[data-column-id]")).toHaveLength(3);
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    )!;
  await act(async () => button("Status").click());
  await act(async () => {
    (
      document.querySelector('[aria-label="Add column"]') as HTMLButtonElement
    ).click();
  });
  const table = parseCSDB(text).tables.get("public.tasks")!;
  expect(alter).toHaveBeenCalledTimes(1);
  expect(table.schema.columns.status).toMatchObject({
    type: "enum",
    options: ["open", "in-progress", "done", "cancelled"],
  });
  expect(table.schema.defaults.status).toBe("open");
  expect(parseCSDB(text).tables.size).toBe(1);
  await act(async () => {
    (
      document.querySelector(
        '[aria-label="Remove Status column"]',
      ) as HTMLButtonElement
    ).click();
  });
  expect(
    parseCSDB(text).tables.get("public.tasks")!.schema.columns.status,
  ).toBeUndefined();
  expect(
    (
      document.querySelector(
        '[data-column-id="uid"] [aria-label^="Remove "]',
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
