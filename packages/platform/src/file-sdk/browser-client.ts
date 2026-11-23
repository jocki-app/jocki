import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
  Emitter,
  Disposable,
  type MessageConnection,
} from "vscode-jsonrpc/browser";
import type { ExtensionDocument, TextEdit } from "./index";

export interface EditorWebviewAPI {
  log(level: "debug" | "info" | "warning" | "error", message: string): void;
  readonly document: ExtensionDocument;
  readonly onDidChangeDocument: import("vscode-jsonrpc").Event<ExtensionDocument>;
  update(edits: TextEdit[]): Promise<void>;
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  getConfiguration<T>(key: string): Promise<T>;
}
const pendingErrors: string[] = [];
let reportError: ((message: string) => void) | undefined;
const recordError = (message: string) => {
  if (reportError) reportError(message.slice(0, 4000));
  else if (pendingErrors.length < 20)
    pendingErrors.push(message.slice(0, 4000));
};
window.addEventListener("error", (event) =>
  recordError(String(event.error?.stack ?? event.message)),
);
window.addEventListener("unhandledrejection", (event) =>
  recordError(String(event.reason?.stack ?? event.reason)),
);
declare global {
  interface Window {
    jockiEditor?: EditorWebviewAPI;
  }
}
window.addEventListener("message", function initialize(event: MessageEvent) {
  if (
    event.source !== window.parent ||
    event.data?.jocki !== "editor-port" ||
    !event.ports[0]
  )
    return;
  window.removeEventListener("message", initialize);
  const port = event.ports[0],
    connection = createMessageConnection(
      new BrowserMessageReader(port),
      new BrowserMessageWriter(port),
    );
  let doc = event.data.document as ExtensionDocument;
  const changed = new Emitter<ExtensionDocument>();
  connection.onNotification("document/changed", (value: ExtensionDocument) => {
    doc = value;
    changed.fire(doc);
  });
  connection.listen();
  reportError = (message) => {
    void connection.sendNotification("log/write", { level: "error", message });
  };
  pendingErrors.splice(0).forEach(reportError);
  window.jockiEditor = {
    log: (level, message) => {
      void connection.sendNotification("log/write", { level, message });
    },
    get document() {
      return structuredClone(doc);
    },
    onDidChangeDocument: changed.event,
    update: async (edits) => {
      doc = await connection.sendRequest<ExtensionDocument>("document/update", {
        version: doc.version,
        edits,
      });
      changed.fire(doc);
    },
    executeCommand: (id, ...args) =>
      connection.sendRequest("command/execute", { id, args }),
    getConfiguration: (key) =>
      connection.sendRequest("configuration/get", { key }),
  };
  window.dispatchEvent(new Event("jocki-ready"));
  window.addEventListener("unload", () => {
    connection.dispose();
    changed.dispose();
    port.close();
  });
});
