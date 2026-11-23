import { it, expect } from "vitest";
import {
  dockTab,
  dockKey,
  dropZone,
  dropRect,
  validDock,
} from "../packages/ui/dock-model";
import { filePatternMatcher } from "../packages/platform/src/file-sdk/file-patterns";
import { FileExtensionHost } from "../packages/platform/src/file-sdk/host";
import type {
  ExtensionContext,
  ExtensionDocument,
} from "../packages/platform/src/file-sdk";
it("uses all nine equal drop regions, preserves tabs while moving and reorders center drops", () => {
  const initial = dockTab(
    { panes: [] },
    { file: "vault/note", view: "edit" },
    [1, 1],
  );
  const left = dockTab(
    initial,
    { file: "vault/note", view: "links" },
    dropZone(0.1, 0.5),
  );
  expect(left.panes.find((p) => p.tabs[0].view === "links")).toMatchObject({
    x: 0,
    y: 0,
    w: 1,
    h: 2,
  });
  expect(left.panes.find((p) => p.tabs[0].view === "edit")).toMatchObject({
    x: 1,
    y: 0,
    w: 1,
    h: 2,
  });
  const quarter = dockTab(
    left,
    { file: "vault/note", view: "outline" },
    dropZone(0.9, 0.1),
  );
  expect(quarter.panes.find((p) => p.tabs[0].view === "outline")).toMatchObject(
    { x: 1, y: 0, w: 1, h: 1 },
  );
  expect(quarter.panes.find((p) => p.tabs[0].view === "edit")).toMatchObject({
    x: 1,
    y: 1,
    w: 1,
    h: 1,
  });
  const target = quarter.panes.find((p) => p.tabs[0].view === "links")!;
  const merged = dockTab(
    quarter,
    { file: "vault/note", view: "outline" },
    [1, 1],
    target.id,
    0,
  );
  expect(
    merged.panes.find((p) => p.id === target.id)!.tabs.map((t) => t.view),
  ).toEqual(["outline", "links"]);
  expect(
    merged.panes
      .flatMap((p) => p.tabs)
      .filter((t) => dockKey(t) === "vault/note:outline"),
  ).toHaveLength(1);
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++) {
      expect(dropZone((x + 0.5) / 3, (y + 0.5) / 3)).toEqual([x, y]);
      expect(dropRect([x, y])).toMatchObject({
        w: x === 1 ? 2 : 1,
        h: y === 1 ? 2 : 1,
      });
    }
  expect(validDock(merged)).toBe(true);
  expect(validDock({ panes: [{ ...target, w: 20 }] })).toBe(false);
});
it("supports extended include and exclusion globs without widening plugin selectors", async () => {
  const match = filePatternMatcher(
    "**/*.{md,csdb}\n!Archive/**\n!**/private-*",
  );
  expect(match("Projects/.hidden/note.md")).toBe(true);
  expect(match("Archive/note.md")).toBe(false);
  expect(match("Projects/private-note.md")).toBe(false);
  expect(match("image.png")).toBe(false);
  expect(
    filePatternMatcher("**/@(todo|tasks).csdb")("Project/tasks.csdb"),
  ).toBe(true);
  expect(() => filePatternMatcher("[invalid")).toThrow();
  let pattern = "Public/**";
  let context: ExtensionContext | undefined;
  const doc: ExtensionDocument = {
    vault: "v",
    id: "f",
    path: "Private/tasks.csdb",
    mime: "application/vnd.csdb",
    contentType: null,
    text: "",
    bytes: new Uint8Array(),
    dirty: false,
    version: 1,
  };
  const host = new FileExtensionHost({
    folders: () => [],
    documents: () => [doc],
    updateDocument: async () => {},
    getConfiguration: () => pattern,
    updateConfiguration: async () => {},
  });
  host.installVerified(
    {
      api: "jocki-extensions/1",
      mimeTypes: ["*/*"],
      id: "test",
      name: "Test",
      version: "1.0.0",
      publisher: "test",
      license: "MIT",
      entrypoints: {},
      contributes: {
        editors: [
          {
            id: "test.editor",
            title: "Editor",
            selectors: [{ pattern: "Public/**/*.csdb" }],
            requiresContentType: false,
          },
        ],
        templates: [
          {
            id: "test.template",
            title: "Template",
            extension: ".md",
            text: "# Template",
          },
        ],
      },
    },
    async () => ({
      activate(ctx) {
        context = ctx;
      },
    }),
  );
  expect(host.editorContributions(doc)).toEqual([]);
  await host.activate("test");
  expect(context!.workspace.documents).toEqual([]);
  pattern = "**/*";
  expect(host.editorContributions(doc)).toEqual([]);
  expect(
    host.editorContributions({ ...doc, path: "Public/tasks.csdb" }),
  ).toHaveLength(1);
  expect(host.editorContributions({ ...doc, path: "Public/note.md" })).toEqual(
    [],
  );
  await host.dispose();
});
