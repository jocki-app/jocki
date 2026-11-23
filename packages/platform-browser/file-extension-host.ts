import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
  type Disposable,
} from "vscode-jsonrpc/browser";
import bootstrap from "../platform/assets/file-sdk/browser-extension-host.js?raw";
import type {
  ExtensionContext,
  FileExtensionManifest,
  FileExtensionModule,
  TextEdit,
  StatusBarItem,
} from "../platform/src/file-sdk";

/** A distinct browser host with opaque origin and a scoped JSON-RPC API. */
export function browserExtensionModule(
  manifest: FileExtensionManifest,
  source: string,
): FileExtensionModule {
  let frame: HTMLIFrameElement | undefined,
    dispose = () => {},
    deactivate = async () => {};
  return {
    async activate(context: ExtensionContext) {
      frame = document.createElement("iframe");
      frame.hidden = true;
      frame.title = manifest.name + " extension host";
      frame.sandbox.add("allow-scripts");
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src data:; style-src 'none'; base-uri 'none'; form-action 'none'"><script>
        const url = URL.createObjectURL(new Blob([${JSON.stringify(bootstrap).replace(/</g, "\\u003c")}], {type:'text/javascript'}));
        const worker = new Worker(url);
        worker.addEventListener('error', event => console.error('Extension worker failed', event.message));
        let connected = false;
        addEventListener('message', event => { if(event.source !== parent) return; if(event.data?.jocki === 'extension-host-stop') {worker.terminate();return;} if(connected || event.data?.jocki !== 'extension-host-port' || !event.ports[0]) return; connected = true; worker.postMessage({...event.data, port:event.ports[0]}, [event.ports[0]]); });
        addEventListener('unload', () => {worker.terminate();URL.revokeObjectURL(url)});
      </script>`;
      const loaded = new Promise<void>((resolve, reject) => {
        frame!.onload = () => resolve();
        frame!.onerror = () => reject(Error("Extension host failed to load"));
      });
      document.body.append(frame);
      await loaded;
      const channel = new MessageChannel(),
        rpc = createMessageConnection(
          new BrowserMessageReader(channel.port1),
          new BrowserMessageWriter(channel.port1),
        );
      const registrations = new Map<string, Disposable>();
      rpc.onNotification(
        "log/write",
        (p: {
          level: "debug" | "info" | "warning" | "error";
          message: string;
        }) => context.logger.log(p.level, p.message),
      );
      rpc.onRequest(
        "contribution/register",
        (p: { kind: string; id: string }) => {
          const key = `${p.kind}:${p.id}`;
          if (registrations.has(key))
            throw Error("Contribution is already registered");
          let d: Disposable;
          if (p.kind === "command")
            d = context.commands.registerCommand(p.id, (...args) =>
              rpc.sendRequest("command/invoke", { id: p.id, args }),
            );
          else if (p.kind === "editor")
            d = context.editors.registerCustomEditorProvider(p.id, {
              resolve: (doc, token) =>
                rpc.sendRequest(
                  "editor/resolve",
                  { id: p.id, document: doc },
                  token,
                ),
            });
          else if (p.kind === "completion")
            d = context.languages.registerCompletionProvider(
              p.id,
              (doc, offset, token) =>
                rpc.sendRequest(
                  "completion/provide",
                  { id: p.id, document: doc, offset },
                  token,
                ),
            );
          else if (p.kind === "search")
            d = context.search.registerTextExtractor(p.id, (doc, token) =>
              rpc.sendRequest(
                "search/extract",
                { id: p.id, document: doc },
                token,
              ),
            );
          else if (p.kind === "view")
            d = context.window.registerTreeDataProvider(p.id, () =>
              rpc.sendRequest("view/items", { id: p.id }),
            );
          else if (p.kind === "willSave")
            d = context.workspace.onWillSaveDocument((event) =>
              rpc.sendRequest(
                "document/willSave",
                { document: event.document },
                event.token,
              ),
            );
          else throw Error("Unknown contribution type");
          registrations.set(key, d);
        },
      );
      rpc.onNotification(
        "contribution/unregister",
        (p: { kind: string; id: string }) => {
          const key = `${p.kind}:${p.id}`;
          registrations.get(key)?.dispose();
          registrations.delete(key);
        },
      );
      rpc.onRequest(
        "document/update",
        (p: {
          vault: string;
          id: string;
          edits: TextEdit[];
          instance?: string;
        }) =>
          context.workspace.updateDocument(p.vault, p.id, p.edits, p.instance),
      );
      rpc.onRequest("command/execute", (p: { id: string; args: unknown[] }) =>
        context.commands.executeCommand(p.id, ...(p.args ?? [])),
      );
      rpc.onRequest("paths/list", () => context.workspace.namedPaths());
      rpc.onRequest(
        "paths/request",
        (request: Parameters<typeof context.workspace.requestNamedPath>[0]) =>
          context.workspace.requestNamedPath(request),
      );
      rpc.onRequest(
        "paths/add",
        (request: Parameters<typeof context.workspace.addNamedPath>[0]) =>
          context.workspace.addNamedPath(request),
      );
      rpc.onRequest(
        "templates/request",
        (request: Parameters<typeof context.workspace.requestTemplate>[0]) =>
          context.workspace.requestTemplate(request),
      );
      rpc.onRequest(
        "configuration/update",
        (p: { key: string; value: unknown }) =>
          context.configuration.update(p.key, p.value),
      );
      rpc.onRequest("status/set", (item: StatusBarItem) => {
        registrations.get("status:" + item.id)?.dispose();
        registrations.set(
          "status:" + item.id,
          context.window.setStatusBarItem(item),
        );
      });
      rpc.onNotification("status/remove", (p: { id: string }) => {
        registrations.get("status:" + p.id)?.dispose();
        registrations.delete("status:" + p.id);
      });
      context.workspace.onDidOpenDocument((doc) => {
        void rpc.sendNotification("document/open", doc);
      });
      context.workspace.onDidChangeDocument((event) => {
        void rpc.sendNotification("document/change", event);
      });
      context.workspace.onDidSaveDocument((doc) => {
        void rpc.sendNotification("document/save", doc);
      });
      context.workspace.onDidCloseDocument((doc) => {
        void rpc.sendNotification("document/close", doc);
      });
      context.workspace.onDidChangeVaultFolders((event) => {
        void rpc.sendNotification("workspace/folders", event);
      });
      context.window.onDidChangeActiveEditor((doc) => {
        void rpc.sendNotification("editor/active", doc ?? null);
      });
      const configuration = () =>
        Object.fromEntries(
          manifest.contributes.configuration.map((c) => [
            c.key,
            context.configuration.get(c.key),
          ]),
        );
      context.configuration.onDidChange(() => {
        void rpc.sendNotification("configuration/change", configuration());
      });
      rpc.listen();
      frame.contentWindow!.postMessage(
        { jocki: "extension-host-port", extensionId: manifest.id },
        "*",
        [channel.port2],
      );
      deactivate = async () => {
        await Promise.race([
          rpc.sendRequest("extension/deactivate"),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      };
      dispose = () => {
        registrations.forEach((d) => d.dispose());
        registrations.clear();
        rpc.dispose();
        channel.port1.close();
        channel.port2.close();
        frame?.contentWindow?.postMessage(
          { jocki: "extension-host-stop" },
          "*",
        );
        frame?.remove();
      };
      context.subscriptions.push({ dispose });
      let activationTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rpc.sendRequest("extension/activate", {
            manifest,
            source,
            folders: context.workspace.folders,
            documents: context.workspace.documents,
            activeDocument: context.window.activeDocument,
            configuration: configuration(),
          }),
          new Promise<never>((_, reject) => {
            activationTimeout = setTimeout(
              () => reject(Error("Extension activation timed out")),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(activationTimeout);
      }
    },
    async deactivate() {
      try {
        await deactivate();
      } finally {
        dispose();
      }
    },
  };
}
