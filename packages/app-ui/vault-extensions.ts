import { parseCSDB } from "../core/vaults/csdb";
import noteTemplate from "./templates/Note.md?raw";
import taskTemplate from "./templates/Tasks.csdb?raw";
export function bundledTemplateSource(path: string) {
  const source = (
    {
      "templates/Note.md": noteTemplate,
      "templates/Tasks.csdb": taskTemplate,
    } as Record<string, string>
  )[path];
  if (source === undefined) throw Error("Unknown bundled template file");
  return source;
}
import { contentTypes } from "../core/vaults/content-types";
import type { FileExtensionHost } from "../platform/src/file-sdk/host";
import type {
  DocumentSelector,
  ExtensionDocument,
  ExtensionContext,
  Disposable,
  StatusBarItem,
} from "../platform/src/file-sdk";

/** Status updates replace their own registrations; they never rebuild document UI. */
function statusProvider(
  context: ExtensionContext,
  render: (doc?: ExtensionDocument) => StatusBarItem[],
) {
  const items = new Map<string, Disposable>();
  let previous = "";
  const update = (doc?: ExtensionDocument) => {
    const next = render(doc),
      signature = JSON.stringify(next);
    if (previous === signature) return;
    previous = signature;
    for (const [id, item] of items)
      if (!next.some((next) => next.id === id)) {
        item.dispose();
        items.delete(id);
      }
    for (const item of next) {
      const old = items.get(item.id);
      items.set(item.id, context.window.setStatusBarItem(item));
      old?.dispose();
    }
  };
  context.window.onDidChangeActiveEditor(update);
  context.configuration.onDidChange(() =>
    update(context.window.activeDocument),
  );
  context.workspace.onDidChangeDocument(({ document }) => {
    const active = context.window.activeDocument;
    if (
      active?.id === document.id &&
      active.vault === document.vault &&
      active.instance === document.instance
    )
      update(document);
  });
  context.subscriptions.push({
    dispose() {
      for (const item of items.values()) item.dispose();
    },
  });
  update(context.window.activeDocument);
}
export function registerBundledFileExtensions(host: FileExtensionHost) {
  type View = {
    id: string;
    title: string;
    component: string;
    icon: string;
    priority?: "default" | "optional";
  };
  const editor = (
    id: string,
    name: string,
    selectors: DocumentSelector[],
    views: View[],
    requiresContentType = false,
  ) => {
    host.installVerified(
      {
        api: "jocki-extensions/1",
        id,
        name,
        mimeTypes: [
          ...new Set(
            selectors.flatMap((selector) =>
              selector.mime
                ? [selector.mime]
                : selector.contentType
                  ? (contentTypes.find(
                      (type) => type.id === selector.contentType,
                    )?.mimeTypes ?? [])
                  : ["*/*"],
            ),
          ),
        ],
        contentTypes: id === "tasks" ? ["jocki.task-list"] : [],
        version: "1.0.0",
        publisher: "jocki",
        license: "GPL-3.0-only",
        entrypoints: {},
        extensionKind: ["ui"],
        activationEvents:
          id === "tasks"
            ? ["onContentType:jocki.task-list"]
            : id === "core.file"
              ? ["onStartupFinished"]
              : [],
        contributes: {
          templates:
            id === "core.markdown"
              ? [
                  {
                    id: "core.markdown.note",
                    title: "Note",
                    extension: ".md",
                    file: "templates/Note.md",
                  },
                ]
              : id === "tasks"
                ? [
                    {
                      id: "tasks.blank",
                      title: "Task list",
                      extension: ".csdb",
                      contentType: "jocki.task-list",
                      file: "templates/Tasks.csdb",
                    },
                  ]
                : [],
          editors: views.map(({ component, ...view }) => ({
            ...view,
            selectors,
            requiresContentType,
          })),
          documentObservers:
            id === "core.file" ? [{ id: "core.file.metadata", selectors }] : [],
        },
      },
      async () => ({
        activate(context) {
          for (const view of views)
            context.editors.registerCustomEditorProvider(view.id, {
              resolve: () => ({ kind: "component", component: view.component }),
            });
          if (id === "core.file")
            statusProvider(context, (doc) =>
              doc
                ? [
                    {
                      id: "core.file.saved",
                      text: doc.dirty ? "Unsaved changes" : "Saved",
                      alignment: "left",
                    },
                    {
                      id: "core.file.mime",
                      text: doc.mime,
                      tooltip: "MIME type",
                      alignment: "right",
                      priority: 10,
                    },
                    {
                      id: "core.file.content-type",
                      text:
                        contentTypes.find((type) => type.id === doc.contentType)
                          ?.name ??
                        doc.contentType ??
                        "No content type",
                      tooltip: "Content type",
                      alignment: "right",
                      priority: 0,
                    },
                  ]
                : [],
            );
          if (id === "tasks") {
            let source = "",
              count = 0;
            statusProvider(context, (doc) => {
              if (doc?.contentType !== "jocki.task-list") return [];
              try {
                if (source !== doc.text) {
                  count =
                    parseCSDB(doc.text).tables.get("public.tasks")?.rows
                      .length ?? 0;
                  source = doc.text;
                }
                return [
                  {
                    id: "tasks.count",
                    text: `${count} ${count === 1 ? "task" : "tasks"}`,
                    alignment: "right",
                    priority: 100,
                  },
                ];
              } catch {
                return [
                  {
                    id: "tasks.count",
                    text: "Task count unavailable",
                    alignment: "right",
                    priority: 100,
                  },
                ];
              }
            });
          }
        },
      }),
      { builtin: true },
    );
  };
  editor(
    "core.file",
    "Core",
    [{ pattern: "**/*" }],
    [
      {
        id: "core.file.editor",
        title: "Text / preview",
        component: "generic",
        icon: "FileText",
        priority: "optional",
      },
      {
        id: "core.file.properties",
        title: "Properties",
        component: "properties",
        icon: "ListFilter",
        priority: "optional",
      },
      {
        id: "core.file.history",
        title: "History",
        component: "history",
        icon: "History",
        priority: "optional",
      },
      {
        id: "core.file.sharing",
        title: "Sharing",
        component: "sharing",
        icon: "Share2",
        priority: "optional",
      },
    ],
  );
  editor(
    "core.markdown",
    "Markdown",
    [{ mime: "text/markdown" }],
    [
      {
        id: "core.markdown.editor",
        title: "Markdown",
        component: "markdown",
        icon: "FilePenLine",
      },
      {
        id: "core.markdown.links",
        title: "Links and backlinks",
        component: "links",
        icon: "Link2",
        priority: "optional",
      },
      {
        id: "core.markdown.outline",
        title: "Outline",
        component: "outline",
        icon: "ListTree",
        priority: "optional",
      },
      {
        id: "core.markdown.tags",
        title: "Tags",
        component: "tags",
        icon: "Tags",
        priority: "optional",
      },
    ],
  );
  editor(
    "core.csdb",
    "CSDB",
    [{ mime: "application/vnd.csdb" }],
    [
      {
        id: "core.csdb.editor",
        title: "Tables",
        component: "csdb",
        icon: "Table2",
      },
      {
        id: "core.csdb.form",
        title: "Attribute form",
        component: "csdb-form",
        icon: "ListTree",
        priority: "optional",
      },
      {
        id: "core.csdb.columns",
        title: "Columns",
        component: "columns",
        icon: "Columns3",
        priority: "optional",
      },
      {
        id: "core.csdb.sql",
        title: "SQL",
        component: "sql",
        icon: "Code2",
        priority: "optional",
      },
    ],
  );
  editor(
    "core.canvas",
    "Canvas",
    [{ mime: "application/vnd.canvas+json" }],
    [
      {
        id: "core.canvas.editor",
        title: "Canvas",
        component: "canvas",
        icon: "Network",
      },
    ],
  );
  editor(
    "tasks",
    "Tasks",
    [{ contentType: "jocki.task-list" }],
    [
      {
        id: "tasks.editor",
        title: "Tasks",
        component: "tasks",
        icon: "ListTodo",
      },
    ],
    true,
  );
  host.installVerified(
    {
      api: "jocki-extensions/1",
      id: "core.navigation",
      name: "Navigation",
      mimeTypes: ["*/*"],
      version: "1.0.0",
      publisher: "jocki",
      license: "GPL-3.0-only",
      entrypoints: {},
      contributes: {
        views: [
          {
            id: "core.navigation.files",
            title: "Files",
            icon: "Folder",
            location: "navigation",
          },
          {
            id: "core.navigation.search",
            title: "Search",
            icon: "Search",
            location: "navigation",
          },
          {
            id: "core.navigation.graph",
            title: "Graph",
            icon: "Network",
            location: "navigation",
          },
        ],
      },
    },
    async () => ({ activate() {} }),
    { builtin: true },
  );
  host.installVerified(
    {
      api: "jocki-extensions/1",
      id: "word-count",
      name: "Word count",
      mimeTypes: ["text/markdown", "text/plain"],
      version: "1.0.0",
      publisher: "jocki",
      license: "GPL-3.0-only",
      entrypoints: {},
      activationEvents: ["onStartupFinished"],
      contributes: {
        documentObservers: [
          { id: "word-count.markdown", selectors: [{ mime: "text/markdown" }] },
        ],
      },
    },
    async () => ({
      activate(context) {
        statusProvider(context, (doc) =>
          !doc || !["text/markdown", "text/plain"].includes(doc.mime)
            ? []
            : [
                {
                  id: "word-count.status",
                  text: `${doc.text.trim() ? doc.text.trim().split(/\s+/u).length : 0} words · ${doc.text.length} characters`,
                  alignment: "right",
                  priority: 100,
                },
              ],
        );
      },
    }),
    { builtin: true },
  );
}
