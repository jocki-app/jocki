import { useEffect, useId, useMemo, useRef } from "react";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import "@atomic-editor/editor/styles.css";
import "./markdown-input.css";

const externalValue = Annotation.define<boolean>();

/** Plain Markdown values use the same controlled draft/save flow as other fields. */
export function MarkdownInput({
  value,
  onChange,
  label,
  inputId,
  disabled = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  inputId?: string;
  disabled?: boolean;
}) {
  const identity = useId();
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ disabled, onChange, label, inputId });
  latest.current = { disabled, onChange, label, inputId };
  const synchronizing = useRef(false);
  const extensions = useMemo(
    () => [
      ViewPlugin.define((editor) => {
        view.current = editor;
        return {
          destroy: () => {
            view.current = null;
          },
        };
      }),
      EditorView.contentAttributes.of(() => ({
        id: latest.current.inputId ?? identity,
        role: "textbox",
        "aria-label": latest.current.label,
        "aria-multiline": "true",
        "aria-readonly": String(latest.current.disabled),
      })),
      // Atomic's reading mode intentionally allows task toggles. A disabled field
      // must reject every document edit, including those dispatched by widgets.
      EditorState.transactionFilter.of((transaction) =>
        transaction.docChanged &&
        latest.current.disabled &&
        !transaction.annotation(externalValue)
          ? []
          : transaction,
      ),
    ],
    [identity],
  );

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // The input state exists only after construction, after plugins initialize.
    editor.setTabFocusMode(true);
    if (editor.state.doc.toString() === value) return;
    // Atomic's source prop is mount-only. Apply synced values and rollbacks
    // explicitly, without remounting or feeding them back as local edits.
    synchronizing.current = true;
    try {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: [
          externalValue.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
    } finally {
      synchronizing.current = false;
    }
  }, [value]);

  return (
    <div
      className="markdown-field min-h-8 rounded-lg border border-input bg-transparent text-base transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 data-readonly:bg-input/50 data-readonly:opacity-50 md:text-sm dark:bg-input/30 dark:data-readonly:bg-input/80"
      data-markdown-field
      data-readonly={disabled || undefined}
      onClickCapture={(event) => {
        if (
          disabled &&
          (event.target as HTMLElement).closest('input[type="checkbox"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <AtomicCodeMirrorEditor
        documentId={identity}
        markdownSource={value}
        readOnly={disabled}
        extensions={extensions}
        onMarkdownChange={(next) => {
          if (!synchronizing.current && !latest.current.disabled)
            latest.current.onChange?.(next);
        }}
        onLinkClick={(url) => {
          // Markdown is workspace data; only ordinary external links can open.
          try {
            const target = new URL(url);
            if (["https:", "http:", "mailto:"].includes(target.protocol))
              window.open(target.href, "_blank", "noopener,noreferrer");
          } catch {
            /* Incomplete and relative links stay editable. */
          }
        }}
      />
    </div>
  );
}
