import { it, expect, vi } from "vitest";
import "vscode-jsonrpc/node";
import {
  FileExtensionHost,
  applyTextEdits,
} from "../packages/platform/src/file-sdk/host";
import type {
  ExtensionContext,
  ExtensionDocument,
} from "../packages/platform/src/file-sdk";
const document: ExtensionDocument = {
  vault: "v",
  id: "file",
  path: "folder/tasks.csdb",
  mime: "application/vnd.csdb",
  contentType: "jocki.task-list",
  text: "content",
  bytes: new Uint8Array(),
  dirty: false,
  version: 1,
};
const manifest = {
  api: "jocki-extensions/1",
  mimeTypes: ["*/*"],
  id: "example",
  name: "Example",
  version: "1.0.0",
  publisher: "test",
  license: "MIT",
  entrypoints: {},
  contributes: {
    editors: [
      {
        id: "example.tasks",
        title: "Tasks",
        selectors: [
          { contentType: "jocki.task-list", pattern: "**/*.csdb" },
        ],
        requiresContentType: true,
      },
    ],
    commands: [{ id: "example.do", title: "Do" }],
  },
};
function host(documents = [document]) {
  return new FileExtensionHost({
    folders: () => [{ id: "v", name: "Vault" }],
    documents: () => structuredClone(documents),
    updateDocument: async () => {},
    getConfiguration: () => undefined,
    updateConfiguration: async () => {},
  });
}
it("advertises contributions without loading code and coalesces lazy activation", async () => {
  const runtime = host();
  let loads = 0,
    calls = 0;
  runtime.installVerified(manifest, async () => {
    loads++;
    return {
      activate(context) {
        context.editors.registerCustomEditorProvider("example.tasks", {
          resolve: () => ({ kind: "webview", html: "<p>Tasks</p>" }),
        });
        context.commands.registerCommand("example.do", () => ++calls);
      },
    };
  });
  expect(runtime.editorContributions(document)).toHaveLength(1);
  expect(loads).toBe(0);
  await Promise.all([
    runtime.resolveEditor("example.tasks", document),
    runtime.executeCommand("example.do"),
  ]);
  expect(loads).toBe(1);
  expect(calls).toBe(1);
  await runtime.dispose();
});
it("requires MIME declarations and prevents selectors widening their document capabilities", async () => {
  const runtime = host();
  expect(() =>
    runtime.installVerified({ ...manifest, mimeTypes: [] }, async () => ({
      activate() {},
    })),
  ).toThrow();
  let context!: ExtensionContext;
  runtime.installVerified(
    { ...manifest, mimeTypes: ["text/markdown"] },
    async () => ({
      activate(ctx) {
        context = ctx;
      },
    }),
  );
  expect(runtime.editorContributions(document)).toEqual([]);
  await runtime.activate("example");
  expect(context.workspace.documents).toEqual([]);
  await expect(
    context.workspace.updateDocument("v", "file", []),
  ).rejects.toThrow();
  await runtime.dispose();
});
it("rejects toolbar popovers that reference undeclared commands", () => {
  const runtime = host();
  expect(() =>
    runtime.installVerified(
      {
        ...manifest,
        contributes: {
          ...manifest.contributes,
          menus: [
            {
              location: "editor/toolbar",
              command: "example.do",
              popover: { items: [{ command: "other.execute", title: "Run" }] },
            },
          ],
        },
      },
      async () => ({ activate() {} }),
    ),
  ).toThrow("Undeclared popover");
});
it("revokes callbacks and file capabilities when an extension is disabled", async () => {
  const runtime = host();
  let context!: ExtensionContext,
    opens = 0;
  runtime.installVerified(manifest, async () => ({
    activate(ctx) {
      context = ctx;
      ctx.workspace.onDidOpenDocument(() => opens++);
      ctx.commands.registerCommand("example.do", () => 1);
    },
  }));
  await runtime.activate("example");
  runtime.didOpenDocument(document);
  expect(opens).toBe(1);
  await runtime.setEnabled("example", false);
  runtime.didOpenDocument(document);
  expect(opens).toBe(1);
  await expect(
    context.workspace.updateDocument("v", "file", []),
  ).rejects.toThrow("disabled");
  await expect(runtime.executeCommand("example.do")).rejects.toThrow();
  await runtime.dispose();
});
it("uses content-type selectors for events and rejects unrelated file writes", async () => {
  const unrelated = {
    ...document,
    id: "private",
    path: "private.md",
    mime: "text/markdown",
    contentType: null,
  };
  const runtime = host([document, unrelated]);
  let context!: ExtensionContext,
    opens = 0;
  runtime.installVerified(manifest, async () => ({
    activate(ctx) {
      context = ctx;
      ctx.workspace.onDidOpenDocument(() => opens++);
    },
  }));
  await runtime.activate("example");
  runtime.didOpenDocument(unrelated);
  runtime.didOpenDocument(document);
  expect(opens).toBe(1);
  expect(context.workspace.documents).toHaveLength(1);
  await expect(
    context.workspace.updateDocument("v", "private", []),
  ).rejects.toThrow("outside");
  expect(
    runtime.editorContributions({ ...document, contentType: null }),
  ).toHaveLength(0);
  await runtime.dispose();
});
it("collects save hooks without acknowledging or persisting a write", async () => {
  const runtime = host();
  let saved = 0;
  runtime.installVerified(manifest, async () => ({
    activate(ctx) {
      ctx.workspace.onWillSaveDocument(() => [
        { from: 0, to: 0, insert: "prefix " },
      ]);
      ctx.workspace.onDidSaveDocument(() => saved++);
    },
  }));
  await runtime.activate("example");
  const edits = await runtime.willSaveDocument(document);
  expect(applyTextEdits(document.text, edits)).toBe("prefix content");
  expect(saved).toBe(0);
  runtime.didSaveDocument(document);
  expect(saved).toBe(1);
  expect(() =>
    applyTextEdits("hello", [
      { from: 0, to: 4, insert: "a" },
      { from: 2, to: 5, insert: "b" },
    ]),
  ).toThrow("overlapping");
  await runtime.dispose();
});
it("rejects undeclared providers and external component access", async () => {
  const runtime = host();
  runtime.installVerified(manifest, async () => ({
    activate(ctx) {
      expect(() =>
        ctx.commands.registerCommand("other.command", () => 1),
      ).toThrow("Undeclared");
      ctx.editors.registerCustomEditorProvider("example.tasks", {
        resolve: () => ({ kind: "component", component: "markdown" }),
      });
    },
  }));
  await expect(
    runtime.resolveEditor("example.tasks", document),
  ).rejects.toThrow("isolated webviews");
  await runtime.dispose();
});
it("keeps active document snapshots current and revokes status items on disable", async () => {
  const runtime = host();
  let context!: ExtensionContext;
  runtime.installVerified(manifest, async () => ({
    activate(ctx) {
      context = ctx;
      ctx.window.setStatusBarItem({ id: "example.status", text: "active" });
    },
  }));
  await runtime.activate("example");
  runtime.didChangeActiveEditor(document);
  runtime.didChangeDocument({
    document: { ...document, text: "latest saved" },
    reason: "save",
  });
  expect(context.window.activeDocument?.text).toBe("latest saved");
  await runtime.setEnabled("example", false);
  expect(runtime.statusItems()).toEqual([]);
  await runtime.dispose();
});
it("routes edits to the active independent draft and isolates status updates from editor contributions", async () => {
  const other = { ...document, instance: "other", text: "other draft" };
  let target: string | undefined, context!: ExtensionContext;
  const runtime = new FileExtensionHost({
    folders: () => [],
    documents: () => [document, other],
    updateDocument: async (_extension, _vault, _id, _edits, instance) => {
      target = instance;
    },
    getConfiguration: () => undefined,
    updateConfiguration: async () => {},
  });
  runtime.installVerified(manifest, async () => ({
    activate(ctx) {
      context = ctx;
    },
  }));
  await runtime.activate("example");
  const contributions = vi.fn(),
    status = vi.fn();
  runtime.onDidChangeContributions(contributions);
  runtime.onDidChangeStatus(status);
  context.window.setStatusBarItem({
    id: "example.count",
    text: "2 tasks",
    alignment: "right",
    priority: 100,
  });
  expect(status).toHaveBeenCalledTimes(1);
  expect(contributions).not.toHaveBeenCalled();
  runtime.didChangeActiveEditor(other);
  runtime.didChangeDocument({
    document: { ...document, text: "unrelated view changed" },
    reason: "edit",
  });
  expect(context.window.activeDocument?.text).toBe("other draft");
  await context.workspace.updateDocument("v", "file", []);
  expect(target).toBe("other");
  await expect(
    context.workspace.updateDocument("v", "file", [], "unknown"),
  ).rejects.toThrow("outside");
  await runtime.dispose();
});
it("cancels a stuck save hook before persistence can be acknowledged", async () => {
  vi.useFakeTimers();
  const runtime = host();
  try {
    runtime.installVerified(manifest, async () => ({
      activate(ctx) {
        ctx.workspace.onWillSaveDocument(() => new Promise(() => {}));
      },
    }));
    await runtime.activate("example");
    const rejected = expect(runtime.willSaveDocument(document)).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(3001);
    await rejected;
  } finally {
    await runtime.dispose();
    vi.useRealTimers();
  }
});
it("rejects late registrations from a disabled activation generation", async () => {
  const runtime = host();
  let finish!: () => void, old!: ExtensionContext;
  runtime.installVerified(manifest, async () => ({
    async activate(ctx) {
      old ??= ctx;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  }));
  const activating = runtime.activate("example");
  await Promise.resolve();
  await runtime.setEnabled("example", false);
  await runtime.setEnabled("example", true);
  expect(() => old.commands.registerCommand("example.do", () => 1)).toThrow(
    "disabled",
  );
  finish();
  await activating;
  expect(runtime.statusItems()).toEqual([]);
  await runtime.dispose();
});
it("lazily activates completion/search providers and validates view commands", async () => {
  const runtime = host();
  let loads = 0;
  runtime.installVerified(
    {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        completion: [
          {
            id: "example.complete",
            selectors: [{ mime: "application/vnd.csdb" }],
          },
        ],
        search: [
          {
            id: "example.search",
            selectors: [{ contentType: "jocki.task-list" }],
          },
        ],
        views: [{ id: "example.view", title: "Items", location: "sidebar" }],
      },
    },
    async () => ({
      activate(ctx) {
        loads++;
        ctx.languages.registerCompletionProvider("example.complete", () => [
          { label: "hello", insertText: "hello" },
        ]);
        ctx.search.registerTextExtractor(
          "example.search",
          (doc) => "extracted " + doc.text,
        );
        ctx.window.registerTreeDataProvider("example.view", () => [
          { id: "item", label: "Item", command: "other.command" },
        ]);
      },
    }),
  );
  expect(loads).toBe(0);
  expect(await runtime.completionsFor(document, 0)).toEqual([
    { label: "hello", insertText: "hello" },
  ]);
  expect(await runtime.extractText(document)).toBe("extracted content");
  await expect(runtime.treeItems("example.view")).rejects.toThrow(
    "Invalid extension tree",
  );
  expect(loads).toBe(1);
  await runtime.dispose();
});

it("shares the menu registry with core, keeps declarations inert and removes uninstalled entries", async () => {
  const runtime = host(),
    load = vi.fn(async () => ({
      activate(context: ExtensionContext) {
        context.commands.registerCommand("example.do", () => true);
      },
    }));
  runtime.ui.replace("core", [
    {
      id: "core.rename",
      title: "Rename",
      command: "core.rename",
      location: "explorer/context",
      when: { kinds: ["folder"] },
      group: "10",
    },
  ]);
  runtime.installVerified(
    {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        menus: [
          {
            location: "explorer/context",
            command: "example.do",
            when: { kinds: ["folder"] },
          },
          { location: "settings", command: "example.do" },
        ],
      },
    },
    load,
  );
  expect(
    runtime
      .menuContributions("explorer/context", { kind: "folder" })
      .map((e) => e.owner),
  ).toEqual(["core", "example"]);
  expect(
    runtime.menuContributions("settings", { kind: "workspace" }),
  ).toHaveLength(1);
  expect(load).not.toHaveBeenCalled();
  expect(
    runtime.menuContributions("explorer/context", { kind: "file" }),
  ).toHaveLength(0);
  await runtime.uninstall("example");
  expect(runtime.menuContributions("settings", {})).toHaveLength(0);
  expect(
    runtime.menuContributions("explorer/context", { kind: "folder" }),
  ).toHaveLength(1);
  await runtime.dispose();
});
