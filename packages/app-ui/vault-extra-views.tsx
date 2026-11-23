import { useReportedError } from "./errors";
import { useEffect, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import { ExtensionWebview } from "./vault-extension-webview";
import { CSDBDraft, parseCSDB } from "../core/vaults/csdb";
import { Button } from "../ui/primitives/button";
import { Textarea } from "../ui/primitives/textarea";
import type { EditorPresentation } from "../platform/src/file-sdk";
import { CSDBSQLResult } from "./vault-sql-result";
export function ExtensionDocumentView({
  runtime,
  file,
  editor,
  revision,
  renderComponent,
}: {
  runtime: VaultRuntime;
  file: { vault: string; id: string; session?: string };
  editor: string;
  revision: number;
  renderComponent(component: string): ReactNode;
}) {
  const [presentation, setPresentation] = useState<EditorPresentation>(),
    [error, setError] = useReportedError("vault-extra-views");
  useEffect(() => {
    let live = true;
    setPresentation(undefined);
    setError("");
    void runtime.extensions
      .resolveEditor(
        editor,
        runtime.editors.snapshot(file.vault, file.id, file.session),
      )
      .then((view) => {
        if (!live) return;
        setPresentation(view);
      })
      .catch((error) => {
        if (live) setError(error);
      });
    return () => {
      live = false;
    };
  }, [runtime, file.vault, file.id, editor]);
  if (error)
    return (
      <p className="p-4 text-muted-foreground">
        This view could not be opened. See Local logs for details.
      </p>
    );
  if (presentation?.kind === "component")
    return renderComponent(presentation.component);
  return presentation?.kind === "webview" ? (
    <ExtensionWebview
      runtime={runtime}
      vault={file.vault}
      id={file.id}
      editorId={editor}
      instance={file.session}
      html={presentation.html}
      revision={revision}
    />
  ) : (
    <p role="status">Opening view…</p>
  );
}
export function VaultSQLView({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const [sql, setSQL] = useState(() => {
      try {
        return "SELECT * FROM " + parseCSDB(value).tableOrder[0];
      } catch {
        return "SELECT * FROM data";
      }
    }),
    [result, setResult] = useState<unknown>(),
    [error, setError] = useReportedError("vault-extra-views");
  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const draft = new CSDBDraft(value);
          const result = draft.sql(sql);
          setResult(result);
          if (!Array.isArray(result) && draft.toString() !== value)
            onChange(draft.toString());
          setError("");
        } catch (error) {
          setError(error);
        }
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-medium">SQL</h2>
        <Button
          type="submit"
          variant="outline"
          size="icon"
          aria-label="Run SQL in draft"
          title="Run SQL in draft"
        >
          <Play />
        </Button>
      </div>
      <Textarea
        aria-label="SQL statement"
        value={sql}
        onChange={(e) => setSQL(e.target.value)}
        className="min-h-36 font-mono"
      />

      {result !== undefined && <CSDBSQLResult value={result} />}
    </form>
  );
}
