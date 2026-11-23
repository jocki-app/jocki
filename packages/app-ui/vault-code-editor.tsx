import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import { useEffect, useRef } from "react";
import { CancellationTokenSource } from "vscode-jsonrpc";
import type {
  CompletionItem,
  CancellationToken,
} from "../platform/src/file-sdk";
loader.config({ monaco });
(
  self as unknown as { MonacoEnvironment: { getWorker(): Worker } }
).MonacoEnvironment = { getWorker: () => new EditorWorker() };
export default function VaultCodeEditor({
  value,
  path,
  onChange,
  complete,
}: {
  value: string;
  path: string;
  onChange(value: string): void;
  complete?(
    offset: number,
    token: CancellationToken,
  ): Promise<CompletionItem[]>;
}) {
  const latest = useRef(complete);
  latest.current = complete;
  const ext = path.split(".").pop()!;
  const language =
    (
      {
        md: "markdown",
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        py: "python",
        yml: "yaml",
        yaml: "yaml",
        json: "json",
      } as Record<string, string>
    )[ext] ?? "plaintext";
  useEffect(() => {
    const provider = monaco.languages.registerCompletionItemProvider(language, {
      async provideCompletionItems(model, position, _context, token) {
        if (
          !model.uri.path.endsWith("/" + path) &&
          model.uri.toString() !== path
        )
          return { suggestions: [] };
        const source = new CancellationTokenSource(),
          abort = token.onCancellationRequested(() => source.cancel());
        try {
          const items =
              (await latest.current?.(
                model.getOffsetAt(position),
                source.token,
              )) ?? [],
            word = model.getWordUntilPosition(position);
          return {
            suggestions: items.map((item) => ({
              label: item.label,
              insertText: item.insertText,
              detail: item.detail,
              kind: monaco.languages.CompletionItemKind.Text,
              range: new monaco.Range(
                position.lineNumber,
                word.startColumn,
                position.lineNumber,
                word.endColumn,
              ),
            })),
          };
        } finally {
          abort.dispose();
          source.dispose();
        }
      },
    });
    return () => provider.dispose();
  }, [path, language]);
  return (
    <Editor
      height="100%"
      path={path}
      language={language}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      options={{
        automaticLayout: true,
        minimap: { enabled: false },
        wordWrap: "on",
        fontSize: 14,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
