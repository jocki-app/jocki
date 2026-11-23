import { useRef, useLayoutEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import "./vault-code-editor";
export default function HistoryDiffEditor({
  original,
  modified,
  language,
  wrap,
}: {
  original: string;
  modified: string;
  language: string;
  wrap: boolean;
}) {
  const wrapMode = wrap ? "on" : "off";
  const requestedWrap = useRef<"on" | "off">(wrapMode);
  requestedWrap.current = wrapMode;
  const instance = useRef<MonacoEditor.IStandaloneDiffEditor | undefined>(
    undefined,
  );
  const wrapping = useRef<{ dispose(): void } | undefined>(undefined);
  useLayoutEffect(() => {
    const editor = instance.current;
    if (!editor) return;
    editor.updateOptions({ wordWrap: wrapMode, diffWordWrap: wrapMode });
    editor.getOriginalEditor().updateOptions({ wordWrapOverride2: wrapMode });
    editor.getModifiedEditor().updateOptions({ wordWrapOverride2: wrapMode });
  }, [wrapMode]);
  useLayoutEffect(
    () => () => {
      const editor = instance.current,
        models = editor?.getModel();
      wrapping.current?.dispose();
      wrapping.current = undefined;
      editor?.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
      instance.current = undefined;
    },
    [],
  );
  return (
    <div className="vault-history-diff" data-history-diff>
      <DiffEditor
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        onMount={(editor) => {
          instance.current = editor;
          const original = editor.getOriginalEditor(),
            modified = editor.getModifiedEditor();
          // Monaco leaves its higher-priority override off when the original
          // pane becomes visible after initially laying out in inline mode.
          const applyWrapping = () => {
            for (const pane of [original, modified]) {
              if (
                pane.getLayoutInfo().width > 0 &&
                pane.getRawOptions().wordWrapOverride2 !== requestedWrap.current
              )
                pane.updateOptions({
                  wordWrapOverride2: requestedWrap.current,
                });
            }
          };
          const listeners = [
            original.onDidLayoutChange(applyWrapping),
            modified.onDidLayoutChange(applyWrapping),
          ];
          wrapping.current = {
            dispose: () => listeners.forEach((listener) => listener.dispose()),
          };
          applyWrapping();
        }}
        original={original}
        modified={modified}
        language={language}
        options={{
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          minimap: { enabled: false },
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: true,
          hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
          wordWrap: wrapMode,
          diffWordWrap: wrapMode,
        }}
      />
    </div>
  );
}
