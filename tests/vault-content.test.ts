import { CompanionFiles } from "./fixtures/companion-files";
import { it, expect } from "vitest";
import {
  parseCSDB,
  CSDBDraft,
  validateCSDBType,
} from "../packages/core/vaults/csdb";
import { contentTypes } from "../packages/core/vaults/content-types";
import { handlersFor } from "../packages/core/vaults/handlers";
import {
  noteMetadata,
  resolveLink,
  rewriteMovedLinks,
  embeddedText,
  graph,
  type LinkableFile,
} from "../packages/core/vaults/knowledge";
import {
  mergeTemplate,
  checkTemplateOnOpen,
} from "../packages/core/vaults/templates";
import { Draft } from "../packages/core/vaults/vault";
import { parseCanvas } from "../packages/core/vaults/canvas";
import * as A from "@automerge/automerge";

const tasks = `--- csdb\nformat: CSDB\nversion: 2\nname: Tasks\nschemas: [public]\ntables: [public.tasks]\n\n--- schema:public\nname: public\ntypes: {}\n\n--- table:public:tasks\nschema: public\nname: tasks\ncolumns: {id: text, uid: text, dtstamp: timestamp, title: text, status: {type: enum, options: [open, in-progress, done, cancelled]}}\nrequired: [id, uid, dtstamp]\nprimary_key: {columns: [id]}\n\n--- data:tasks\nid,uid,dtstamp,title,status\n1,u1,2026-01-01T00:00:00Z,"Buy milk, bread",open\n`;
it("uses real CSDB CSV escaping, validation and draft-only SQL mutations", () => {
  const parsed = parseCSDB(tasks);
  expect(parsed.tables.get("public.tasks")!.rows[0].title).toBe(
    "Buy milk, bread",
  );
  validateCSDBType(
    tasks,
    contentTypes.find((t) => t.id === "jocki.task-list"),
  );
  const draft = new CSDBDraft(tasks);
  draft.sql("UPDATE public.tasks SET status = ? WHERE id = ?", ["done", "1"]);
  expect(
    draft.sql("SELECT title FROM public.tasks WHERE status = ?", ["done"]),
  ).toEqual([{ title: "Buy milk, bread" }]);
  expect(parseCSDB(tasks).tables.get("public.tasks")!.rows[0].status).toBe(
    "open",
  );
  expect(() =>
    validateCSDBType(
      tasks.replace("required: [id, uid, dtstamp]", "required: [id, uid]"),
      contentTypes[0],
    ),
  ).toThrow("required");
});
it("resolves aliases and heading/block references and rewrites only matching links", () => {
  const one: LinkableFile = {
    id: "a",
    vault: "v",
    path: "notes/one.md",
    text: "See [[two#Title|friend]] and [two](two.md).\n```\n[[fake]]\n```\n",
  };
  const two: LinkableFile = {
    id: "b",
    vault: "v",
    path: "notes/two.md",
    text: "---\naliases: [friend]\ntags: [work/project]\n---\n# Title\nA paragraph ^block\n\n# Next\nOther",
  };
  expect(noteMetadata(one.text).links).toHaveLength(2);
  expect(resolveLink("friend#^block", one, [one, two])).toEqual([two]);
  expect(embeddedText(two.text, "^block")).toContain("A paragraph");
  expect(embeddedText(two.text, "Title")).not.toContain("# Next");
  expect(rewriteMovedLinks(one, two, "new/two.md", [one, two])).toContain(
    "[[new/two.md#Title|friend]]",
  );
});
it("checks referenced templates only through open and keeps the result in a draft", async () => {
  expect(
    mergeTemplate(
      "first\nlast\n",
      "first local\nlast\n",
      "first\nlast updated\n",
    ),
  ).toBe("first local\nlast updated\n");
  const original = A.from({
    format: "saddle-file/1" as const,
    id: "a",
    epoch: 0,
    generation: "original",
    kind: "text" as const,
    text: "first local\nlast\n",
    csdb: null,
    bytes: new Uint8Array(),
    mime: "text/markdown",
    resource: null,
    invalidResource: null,
    template: { hint: "source.md", file: "source", baseline: "first\nlast\n" },
  });
  const draft = new Draft("a", original);
  let reads = 0;
  expect(reads).toBe(0);
  await checkTemplateOnOpen(draft, async () => {
    reads++;
    return "first\nlast updated\n";
  });
  expect(reads).toBe(1);
  expect(draft.dirty).toBe(true);
  expect(original.text).not.toContain("updated");
});
it("round trips standard JSON Canvas nodes and rejects dangling edges", () => {
  const doc = parseCanvas(
    JSON.stringify({
      nodes: [
        {
          id: "a",
          type: "text",
          text: "# Note",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          custom: true,
        },
      ],
      edges: [],
    }),
  );
  expect(doc.nodes[0].custom).toBe(true);
  expect(() =>
    parseCanvas(
      JSON.stringify({
        ...doc,
        edges: [{ id: "e", fromNode: "a", toNode: "missing" }],
      }),
    ),
  ).toThrow();
});
it("prefers specialized handlers and preserves multiple choices", () => {
  const base = {
    name: "test",
    contentTypes: ["jocki.task-list"],
    requiresContentType: true,
    mimeTypes: [],
    extensions: [],
  };
  const file = {
    path: "tasks.csdb",
    mime: "application/vnd.csdb",
    contentType: "jocki.task-list",
  };
  expect(
    handlersFor(file, [
      { ...base, id: "one" },
      { ...base, id: "two" },
    ]),
  ).toHaveLength(2);
  expect(
    handlersFor({ ...file, contentType: null }, [{ ...base, id: "one" }]),
  ).toEqual([]);
});
it("keeps graph nodes in their vault when independent vaults reuse IDs", () => {
  const files = [
    { id: "one", vault: "a", path: "one.md", text: "[[two]]" },
    { id: "two", vault: "a", path: "two.md", text: "" },
    { id: "one", vault: "b", path: "one.md", text: "" },
  ];
  const local = graph(files, "a/one", 1);
  expect(local.files.map((file) => `${file.vault}/${file.id}`)).toEqual([
    "a/one",
    "a/two",
  ]);
  expect(local.edges).toEqual([{ from: "a/one", to: "a/two" }]);
});

it("reads a linked CSDB template from its structured state when reopening a file", async () => {
  const { FileVault, fileText } = await import("../packages/core/vaults/vault");
  const { VaultEditors } = await import("../packages/core/vaults/editors");
  const { FileExtensionHost } =
    await import("../packages/platform/src/file-sdk/host");
  const { utf8 } = await import("../packages/core/crypto");
  const fs = new CompanionFiles();
  const vault = await FileVault.open(fs, "test");
  await vault.configure({ history: true });
  const source = await vault.create("Source.csdb", utf8.encode(tasks)),
    id = await vault.create("Linked.csdb", utf8.encode(tasks));
  let linked = vault.draft(id);
  linked.template = {
    hint: "Source.csdb",
    file: source,
    baseline: fileText(vault.doc(source)),
  };
  linked = await vault.save(linked);
  vault.release(linked);
  const edit = vault.draft(source);
  edit.text = edit.text.replace("Buy milk, bread", "Buy eggs");
  const saved = await vault.save(edit);
  vault.release(saved);
  expect(vault.doc(source).text).toBe("");
  const host = new FileExtensionHost({
      folders: () => [],
      documents: () => [],
      updateDocument: async () => {},
      getConfiguration: () => undefined,
      updateConfiguration: async () => {},
    }),
    editors = new VaultEditors(new Map([[vault.id, vault]]), host);
  const session = await editors.open(vault.id, id);
  expect(
    parseCSDB(session.draft.text).tables.get("public.tasks")!.rows[0].title,
  ).toBe("Buy eggs");
  expect(session.draft.dirty).toBe(true);
  expect(fileText(vault.doc(id))).toContain("Buy milk, bread");
  await editors.close(vault.id, id, true);
  await host.dispose();
});

it("reuses an in-flight editor open for the same file instance", async () => {
  const { FileVault } = await import("../packages/core/vaults/vault");
  const { VaultEditors } = await import("../packages/core/vaults/editors");
  const { FileExtensionHost } =
    await import("../packages/platform/src/file-sdk/host");
  const { utf8 } = await import("../packages/core/crypto");
  const vault = await FileVault.open(new CompanionFiles(), "one");
  const id = await vault.create("note.md", utf8.encode("one editor"));
  const editors = new VaultEditors(
    new Map([[vault.id, vault]]),
    new FileExtensionHost({
      folders: () => [],
      documents: () => [],
      updateDocument: async () => {},
      getConfiguration: () => undefined,
      updateConfiguration: async () => {},
    }),
  );
  const [first, second] = await Promise.all([
    editors.open(vault.id, id),
    editors.open(vault.id, id),
  ]);
  expect(first).toBe(second);
  expect(editors.sessions.size).toBe(1);
});
