import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
  Emitter,
  Disposable,
  CancellationToken,
} from "vscode-jsonrpc/browser";
import type {
  ExtensionContext,
  FileExtensionManifest,
  FileExtensionModule,
  ExtensionDocument,
  DocumentChange,
  VaultFolder,
  TextEdit,
  WillSaveEvent,
} from "./index";

/** Runs on its own worker thread, created by an opaque-origin host frame. */
globalThis.addEventListener(
  "message",
  function initialize(event: MessageEvent) {
    if (
      event.data?.jocki !== "extension-host-port" ||
      !(event.data.port instanceof MessagePort)
    )
      return;
    globalThis.removeEventListener("message", initialize);
    const port = event.data.port as MessagePort,
      connection = createMessageConnection(
        new BrowserMessageReader(port),
        new BrowserMessageWriter(port),
      );
    globalThis.addEventListener("error", (event) => {
      void connection.sendNotification("log/write", {
        level: "error",
        message: String(event.error?.stack ?? event.message).slice(0, 4000),
      });
    });
    globalThis.addEventListener("unhandledrejection", (event) => {
      void connection.sendNotification("log/write", {
        level: "error",
        message: String(event.reason?.stack ?? event.reason).slice(0, 4000),
      });
    });
    const handlers = new Map<string, unknown>(),
      registrations: Promise<unknown>[] = [],
      subscriptions: import("vscode-jsonrpc").Disposable[] = [];
    const controller = new AbortController();
    const open = new Emitter<ExtensionDocument>(),
      change = new Emitter<DocumentChange>(),
      save = new Emitter<ExtensionDocument>(),
      close = new Emitter<ExtensionDocument>(),
      active = new Emitter<ExtensionDocument | undefined>(),
      folders = new Emitter<{ added: VaultFolder[]; removed: VaultFolder[] }>();
    let documents: ExtensionDocument[] = [],
      vaults: VaultFolder[] = [],
      selected: ExtensionDocument | undefined;
    let configuration: Record<string, unknown> = {},
      module: FileExtensionModule | undefined;
    const configChanged = new Emitter<void>();
    const track = (key: string, kind: string, value: unknown) => {
      handlers.set(key, value);
      registrations.push(
        connection.sendRequest("contribution/register", { id: key, kind }),
      );
      const disposable = Disposable.create(() => {
        handlers.delete(key);
        void connection.sendNotification("contribution/unregister", {
          id: key,
          kind,
        });
      });
      subscriptions.push(disposable);
      return disposable;
    };
    connection.onRequest(
      "extension/activate",
      async (input: {
        manifest: FileExtensionManifest;
        source: string;
        configuration: Record<string, unknown>;
        folders: VaultFolder[];
        documents: ExtensionDocument[];
        activeDocument?: ExtensionDocument;
      }) => {
        documents = input.documents;
        vaults = input.folders;
        configuration = input.configuration;
        selected = input.activeDocument;
        const context: ExtensionContext = {
          logger: {
            log: (level, message) => {
              void connection.sendNotification("log/write", { level, message });
            },
          },
          extension: input.manifest,
          signal: controller.signal,
          subscriptions,
          commands: {
            registerCommand: (id, handler) => track(id, "command", handler),
            executeCommand: (id, ...args) =>
              connection.sendRequest("command/execute", { id, args }),
          },
          editors: {
            registerCustomEditorProvider: (id, provider) =>
              track(id, "editor", provider),
          },
          workspace: {
            get folders() {
              return structuredClone(vaults);
            },
            get documents() {
              return structuredClone(documents);
            },
            onDidOpenDocument: open.event,
            onDidChangeDocument: change.event,
            onDidSaveDocument: save.event,
            onDidCloseDocument: close.event,
            onDidChangeVaultFolders: folders.event,
            onWillSaveDocument: (handler) =>
              track(input.manifest.id + ".willSave", "willSave", handler),
            updateDocument: (vault, id, edits, instance) =>
              connection.sendRequest("document/update", {
                vault,
                id,
                edits,
                instance,
              }),
            namedPaths: () => connection.sendRequest("paths/list"),
            requestNamedPath: (request) =>
              connection.sendRequest("paths/request", request),
            addNamedPath: (request) =>
              connection.sendRequest("paths/add", request),
            requestTemplate: (request) =>
              connection.sendRequest("templates/request", request),
          },
          languages: {
            registerCompletionProvider: (id, provider) =>
              track(id, "completion", provider),
          },
          search: {
            registerTextExtractor: (id, provider) =>
              track(id, "search", provider),
          },
          window: {
            get activeDocument() {
              return selected && structuredClone(selected);
            },
            onDidChangeActiveEditor: active.event,
            registerTreeDataProvider: (id, provider) =>
              track(id, "view", provider),
            setStatusBarItem: (item) => {
              const key = item.id;
              registrations.push(connection.sendRequest("status/set", item));
              return Disposable.create(() => {
                void connection.sendNotification("status/remove", { id: key });
              });
            },
          },
          configuration: {
            onDidChange: configChanged.event,
            get: <T>(key: string) => configuration[key] as T,
            update: async (key, value) => {
              await connection.sendRequest("configuration/update", {
                key,
                value,
              });
              configuration[key] = value;
            },
          },
        };
        const url = URL.createObjectURL(
          new Blob([input.source], { type: "text/javascript" }),
        );
        try {
          module = (await import(
            /* @vite-ignore */ url
          )) as FileExtensionModule;
          if (typeof module.activate !== "function")
            throw Error("Extension must export activate(context)");
          await module.activate(context);
          await Promise.all(registrations.splice(0));
        } finally {
          URL.revokeObjectURL(url);
        }
      },
    );
    connection.onRequest(
      "command/invoke",
      async (p: { id: string; args: unknown[] }) =>
        (handlers.get(p.id) as (...args: unknown[]) => unknown)(...p.args),
    );
    connection.onRequest(
      "editor/resolve",
      async (p: { id: string; document: ExtensionDocument }, token) =>
        (handlers.get(p.id) as import("./index").CustomEditorProvider).resolve(
          p.document,
          token,
        ),
    );
    connection.onRequest(
      "completion/provide",
      async (
        p: { id: string; document: ExtensionDocument; offset: number },
        token,
      ) =>
        (
          handlers.get(p.id) as (
            doc: ExtensionDocument,
            offset: number,
            token: import("vscode-jsonrpc").CancellationToken,
          ) => unknown
        )(p.document, p.offset, token),
    );
    connection.onRequest(
      "search/extract",
      async (p: { id: string; document: ExtensionDocument }, token) =>
        (
          handlers.get(p.id) as (
            doc: ExtensionDocument,
            token: import("vscode-jsonrpc").CancellationToken,
          ) => unknown
        )(p.document, token),
    );
    connection.onRequest("view/items", async (p: { id: string }) =>
      (handlers.get(p.id) as () => unknown)(),
    );
    connection.onRequest(
      "document/willSave",
      async (p: { document: ExtensionDocument }, token) =>
        (
          handlers.get(event.data.extensionId + ".willSave") as (
            event: WillSaveEvent,
          ) => unknown
        )?.({ document: p.document, token }),
    );
    connection.onNotification("document/open", (doc: ExtensionDocument) => {
      documents = [
        ...documents.filter((d) => d.id !== doc.id || d.vault !== doc.vault),
        doc,
      ];
      open.fire(doc);
    });
    connection.onNotification("document/change", (e: DocumentChange) => {
      documents = documents.map((d) =>
        d.id === e.document.id && d.vault === e.document.vault ? e.document : d,
      );
      if (selected?.id === e.document.id && selected.vault === e.document.vault)
        selected = e.document;
      change.fire(e);
    });
    connection.onNotification("document/save", (doc: ExtensionDocument) =>
      save.fire(doc),
    );
    connection.onNotification("document/close", (doc: ExtensionDocument) => {
      documents = documents.filter(
        (d) => d.id !== doc.id || d.vault !== doc.vault,
      );
      close.fire(doc);
    });
    connection.onNotification(
      "editor/active",
      (doc: ExtensionDocument | undefined) => {
        selected = doc;
        active.fire(doc);
      },
    );
    connection.onNotification(
      "configuration/change",
      (value: Record<string, unknown>) => {
        configuration = value;
        configChanged.fire();
      },
    );
    connection.onNotification(
      "workspace/folders",
      (e: { added: VaultFolder[]; removed: VaultFolder[] }) => {
        vaults = [
          ...vaults.filter((v) => !e.removed.some((r) => r.id === v.id)),
          ...e.added,
        ];
        folders.fire(e);
      },
    );
    connection.onRequest("extension/deactivate", async () => {
      controller.abort();
      await module?.deactivate?.();
      subscriptions
        .splice(0)
        .reverse()
        .forEach((d) => d.dispose());
    });
    connection.listen();
  },
);
