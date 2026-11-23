import { useEffect, useMemo, useRef } from "react";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/browser";
import bootstrap from "../platform/assets/file-sdk/browser-client.js?raw";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { TextEdit } from "../platform/src/file-sdk";

/** Opaque-origin UI: no native globals, origin storage, network, or parent DOM. */
export function ExtensionWebview({
  runtime,
  vault,
  id,
  editorId,
  instance,
  html,
  revision,
}: {
  runtime: VaultRuntime;
  vault: string;
  id: string;
  editorId: string;
  instance?: string;
  html: string;
  revision: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    connection = useRef<MessageConnection | null>(null),
    channel = useRef<MessageChannel | null>(null);
  const document = useMemo(() => {
    if (html.length > 1024 * 1024)
      throw Error("Extension editor HTML exceeds the limit");
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><script>${bootstrap.replace(/<\/script/gi, "<\\/script")}</script>${html}`;
  }, [html]);
  const connect = () => {
    connection.current?.dispose();
    channel.current?.port1.close();
    channel.current?.port2.close();
    const channels = (channel.current = new MessageChannel());
    const rpc = (connection.current = createMessageConnection(
      new BrowserMessageReader(channels.port1),
      new BrowserMessageWriter(channels.port1),
    ));
    const active = () => {
      const contribution = runtime.extensions
        .editorContributions(runtime.editors.snapshot(vault, id, instance))
        .find((e) => e.id === editorId);
      if (!contribution) throw Error("Editor permission was removed");
      return contribution;
    };
    rpc.onNotification(
      "log/write",
      (input: {
        level: "debug" | "info" | "warning" | "error";
        message: string;
      }) =>
        runtime.extensions.writeLog(
          active().extension,
          input.level,
          input.message,
        ),
    );
    rpc.onRequest(
      "document/update",
      async (input: { version: number; edits: TextEdit[] }) => {
        const doc = runtime.editors.snapshot(vault, id, instance);
        active();
        if (input.version !== doc.version)
          throw Error(
            "Document changed; retry against the latest editor state",
          );
        if (!Array.isArray(input.edits) || input.edits.length > 10000)
          throw Error("Invalid editor edits");
        runtime.editors.update(vault, id, input.edits, instance);
        return runtime.editors.snapshot(vault, id, instance);
      },
    );
    rpc.onRequest(
      "command/execute",
      async (input: { id: string; args: unknown[] }) => {
        if (
          !runtime.extensions
            .commandContributions()
            .some(
              (c) => c.id === input.id && c.extension === active().extension,
            )
        )
          throw Error("Undeclared editor command");
        return runtime.extensions.executeCommand(
          input.id,
          ...(input.args ?? []),
        );
      },
    );
    rpc.onRequest("configuration/get", (input: { key: string }) => {
      const manifest = runtime.extensions
        .manifests()
        .find((m) => m.id === active().extension)!;
      const declaration = manifest.contributes.configuration.find(
        (c) => c.key === input.key,
      );
      if (!declaration) throw Error("Undeclared configuration key");
      return (
        runtime.extensions.capabilities.getConfiguration(
          manifest.id,
          input.key,
        ) ?? declaration.default
      );
    });
    rpc.listen();
    frame.current!.contentWindow!.postMessage(
      {
        jocki: "editor-port",
        document: runtime.editors.snapshot(vault, id, instance),
      },
      "*",
      [channels.port2],
    );
  };
  useEffect(() => {
    if (connection.current)
      void connection.current.sendNotification(
        "document/changed",
        runtime.editors.snapshot(vault, id, instance),
      );
  }, [revision]);
  useEffect(
    () => () => {
      connection.current?.dispose();
      channel.current?.port1.close();
      channel.current?.port2.close();
    },
    [],
  );
  return (
    <iframe
      ref={frame}
      title="Extension editor"
      sandbox="allow-scripts"
      srcDoc={document}
      onLoad={connect}
      style={{ border: 0, width: "100%", height: "100%" }}
    />
  );
}
