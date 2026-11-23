import { useEffect, useRef } from "react";
import {
  EditorState,
  StateField,
  Annotation,
  Transaction,
  type Range,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  WidgetType,
  keymap,
  drawSelection,
  rectangularSelection,
  hoverTooltip,
  type DecorationSet,
} from "@codemirror/view";
import {
  markdown,
  markdownLanguage,
  markdownKeymap,
} from "@codemirror/lang-markdown";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import {
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { vim } from "@replit/codemirror-vim";
import {
  inlinePreview,
  highlightMarkdown,
  atomicEditorTheme,
  atomicMarkdownSyntax,
  wikiLinks,
} from "@atomic-editor/editor";
import { marked } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import { embeddedText, noteMetadata } from "../core/vaults/knowledge";
import "@atomic-editor/editor/styles.css";
import "katex/dist/katex.min.css";
import type {
  CompletionItem,
  CancellationToken,
} from "../platform/src/file-sdk";
import { CancellationTokenSource } from "vscode-jsonrpc";

const external = Annotation.define<boolean>();
export interface MarkdownAsset {
  mime: string;
  text?: string;
  url?: string;
}
export interface MarkdownContext {
  suggestions(query: string): { target: string; label: string }[];
  asset(target: string): MarkdownAsset | undefined;
  open(target: string): void;
  complete?(
    offset: number,
    token: CancellationToken,
  ): Promise<CompletionItem[]>;
}
const safeHTML = (source: string) =>
  DOMPurify.sanitize(source, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "form", "input"],
    FORBID_ATTR: ["style"],
  });
function splitCells(line: string) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
export interface MarkdownTable {
  from: number;
  to: number;
  indent: string;
  cells: string[][];
  alignment: string[];
}
/** Indentation is preserved verbatim, including tables indented beyond four spaces. */
export function markdownTables(source: string): MarkdownTable[] {
  const lines = source.split("\n"),
    results: MarkdownTable[] = [];
  let offset = 0,
    fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      fence = fence ? "" : marker[1][0];
      offset += line.length + 1;
      continue;
    }
    if (
      !fence &&
      line.includes("|") &&
      lines[i + 1] &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const indent = /^\s*/.exec(line)![0];
      const cells = [splitCells(line)],
        alignment = splitCells(lines[i + 1]);
      let end = i + 2;
      while (
        end < lines.length &&
        lines[end].startsWith(indent) &&
        lines[end].trim().includes("|") &&
        lines[end].trim()
      ) {
        cells.push(splitCells(lines[end]));
        end++;
      }
      const to = offset + lines.slice(i, end).join("\n").length;
      results.push({ from: offset, to, indent, cells, alignment });
      offset = to + 1;
      i = end - 1;
    } else offset += line.length + 1;
  }
  return results;
}
class TableWidget extends WidgetType {
  constructor(readonly model: MarkdownTable) {
    super();
  }
  eq(other: TableWidget) {
    return JSON.stringify(this.model) === JSON.stringify(other.model);
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "vault-md-table";
    wrap.style.marginInlineStart = `${this.model.indent.replace(/\t/g, "    ").length}ch`;
    const table = document.createElement("table");
    wrap.append(table);
    for (let row = 0; row < this.model.cells.length; row++) {
      const tr = document.createElement("tr");
      table.append(tr);
      for (let col = 0; col < this.model.cells[0].length; col++) {
        const td = document.createElement(row === 0 ? "th" : "td"),
          input = document.createElement("input");
        input.value = this.model.cells[row][col] ?? "";
        input.setAttribute(
          "aria-label",
          `Table row ${row + 1} column ${col + 1}`,
        );
        input.oninput = () => {
          const position = view.posAtDOM(wrap),
            model = markdownTables(view.state.doc.toString()).find(
              (t) => position >= t.from && position <= t.to,
            );
          if (!model) return;
          const rows = [...table.rows].map((r) =>
            [...r.cells].map((c) => c.querySelector("input")!.value),
          );
          const line = (cells: string[]) =>
            model.indent +
            "| " +
            cells
              .map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " "))
              .join(" | ") +
            " |";
          const next = [
            line(rows[0]),
            line(model.alignment),
            ...rows.slice(1).map(line),
          ].join("\n");
          view.dispatch({
            changes: { from: model.from, to: model.to, insert: next },
          });
        };
        td.append(input);
        tr.append(td);
      }
    }
    const add = document.createElement("button");
    add.textContent = "+ Row";
    add.onclick = () => {
      const position = view.posAtDOM(wrap),
        model = markdownTables(view.state.doc.toString()).find(
          (t) => position >= t.from && position <= t.to,
        );
      if (model)
        view.dispatch({
          changes: {
            from: model.to,
            insert:
              "\n" +
              model.indent +
              "| " +
              model.cells[0].map(() => " ").join(" | ") +
              " |",
          },
        });
    };
    wrap.append(add);
    return wrap;
  }
  updateDOM(dom: HTMLElement) {
    const rows = dom.querySelectorAll("tr");
    if (
      rows.length !== this.model.cells.length ||
      rows[0]?.querySelectorAll("input").length !== this.model.cells[0].length
    )
      return false;
    rows.forEach((row, r) =>
      row.querySelectorAll("input").forEach((input, c) => {
        if (document.activeElement !== input)
          input.value = this.model.cells[r][c] ?? "";
      }),
    );
    return true;
  }
  ignoreEvent() {
    return true;
  }
}
class PreviewWidget extends WidgetType {
  constructor(
    readonly kind: "embed" | "math" | "mermaid" | "html",
    readonly value: string,
    readonly context: MarkdownContext,
  ) {
    super();
  }
  eq(other: PreviewWidget) {
    return other.kind === this.kind && other.value === this.value;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = "vault-md-preview vault-md-" + this.kind;
    if (this.kind === "math") {
      try {
        div.innerHTML = DOMPurify.sanitize(
          katex.renderToString(this.value, {
            displayMode: true,
            throwOnError: false,
            trust: false,
            maxExpand: 1000,
            maxSize: 20,
          }),
        );
      } catch {
        div.textContent = this.value;
      }
    } else if (this.kind === "html") div.innerHTML = safeHTML(this.value);
    else if (this.kind === "mermaid") {
      div.textContent = "Rendering diagram…";
      void import("mermaid")
        .then(async ({ default: mermaid }) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            maxTextSize: 50000,
          });
          const result = await mermaid.render(
            "diagram-" + crypto.randomUUID(),
            this.value,
          );
          div.innerHTML = DOMPurify.sanitize(result.svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
        })
        .catch((error) => {
          div.textContent = String(error);
        });
    } else {
      const target = this.value.split("|")[0],
        asset = this.context.asset(target);
      if (!asset) {
        div.textContent = "Missing: " + target;
        div.onclick = () => this.context.open(target);
        return div;
      }
      if (asset.mime === "text/markdown") {
        div.innerHTML = safeHTML(
          marked.parse(embeddedText(asset.text ?? "", target.split("#")[1]), {
            async: false,
          }),
        );
        div.onclick = (e) => {
          const link = (e.target as HTMLElement).closest("a");
          if (link) {
            e.preventDefault();
            this.context.open(link.getAttribute("href") ?? "");
          }
        };
      } else if (asset.url) {
        const tag = asset.mime.startsWith("image/")
          ? "img"
          : asset.mime.startsWith("audio/")
            ? "audio"
            : asset.mime.startsWith("video/")
              ? "video"
              : "a";
        const element = document.createElement(tag);
        if (element instanceof HTMLMediaElement) element.controls = true;
        if (element instanceof HTMLAnchorElement) {
          element.href = asset.url;
          element.textContent = target;
          element.download = target;
        } else element.setAttribute("src", asset.url);
        div.append(element);
      } else div.textContent = asset.text ?? target;
    }
    return div;
  }
  ignoreEvent() {
    return true;
  }
}
function previews(context: MarkdownContext): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state),
    update: (prior, transaction) =>
      transaction.docChanged || transaction.selection
        ? build(transaction.state)
        : prior,
    provide: (field) => EditorView.decorations.from(field),
  });
  function build(state: EditorState) {
    const source = state.doc.toString(),
      decorations: Range<Decoration>[] = [],
      covered: [number, number][] = [];
    for (const table of markdownTables(source)) {
      covered.push([table.from, table.to]);
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new TableWidget(table),
        }).range(table.from, table.to),
      );
    }
    const selected = (from: number, to: number) =>
      state.selection.ranges.some(
        (r) => (r.from >= from && r.from <= to) || (r.to >= from && r.to <= to),
      );
    const add = (
      from: number,
      to: number,
      kind: "embed" | "math" | "mermaid" | "html",
      value: string,
      block: boolean,
      reveal = true,
    ) => {
      if (
        covered.some(([a, b]) => from < b && to > a) ||
        (reveal && selected(from, to))
      )
        return;
      covered.push([from, to]);
      decorations.push(
        Decoration.replace({
          block,
          widget: new PreviewWidget(kind, value, context),
        }).range(from, to),
      );
    };
    for (const m of source.matchAll(
      /^\s*```mermaid\s*\n([\s\S]*?)^\s*```\s*$/gm,
    ))
      add(m.index!, m.index! + m[0].length, "mermaid", m[1], true);
    for (const m of source.matchAll(/^\s*\$\$\s*\n?([\s\S]*?)\$\$\s*$/gm))
      add(m.index!, m.index! + m[0].length, "math", m[1], true);
    for (const m of source.matchAll(/(?<!\$)\$([^$\n]+)\$(?!\$)/g))
      add(m.index!, m.index! + m[0].length, "math", m[1], false);
    for (const m of source.matchAll(
      /!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^\s)]+)\)/g,
    )) {
      const from = m.index!,
        line = state.doc.lineAt(from);
      add(
        from,
        from + m[0].length,
        "embed",
        m[1] ?? m[2],
        line.text.trim() === m[0],
        false,
      );
    }
    for (const m of source.matchAll(
      /^<(details|div|table|figure|section)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*$/gm,
    ))
      add(m.index!, m.index! + m[0].length, "html", m[0], true);
    for (const m of source.matchAll(/^>\s*\[!([\w-]+)\][+-]?/gm))
      decorations.push(
        Decoration.line({ class: "vault-md-callout" }).range(
          state.doc.lineAt(m.index!).from,
        ),
      );
    for (const m of source.matchAll(/%%[\s\S]*?%%/g))
      if (
        !selected(m.index!, m.index! + m[0].length) &&
        !covered.some(([a, b]) => m.index! < b && m.index! + m[0].length > a)
      )
        decorations.push(
          Decoration.replace({}).range(m.index!, m.index! + m[0].length),
        );
    return Decoration.set(decorations, true);
  }
}
export function VaultMarkdownEditor({
  value,
  onChange,
  context,
  vimMode,
  reveal,
}: {
  value: string;
  onChange(value: string): void;
  context: MarkdownContext;
  vimMode: boolean;
  reveal?: string;
}) {
  const parent = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    latest = useRef({ onChange, context });
  latest.current = { onChange, context };
  useEffect(() => {
    const proxy: MarkdownContext = {
      suggestions: (q) => latest.current.context.suggestions(q),
      asset: (t) => latest.current.context.asset(t),
      open: (t) => latest.current.context.open(t),
      complete: (offset, token) =>
        latest.current.context.complete?.(offset, token) ?? Promise.resolve([]),
    };
    const completion: CompletionSource = async (context) => {
      const cancellation = new CancellationTokenSource();
      context.addEventListener("abort", () => cancellation.cancel(), {
        onDocChange: true,
      });
      try {
        const items = await proxy.complete!(context.pos, cancellation.token);
        if (context.aborted || !items.length) return null;
        const word = context.matchBefore(/[\w.-]*/);
        return {
          from: word?.from ?? context.pos,
          options: items.map((item) => ({
            label: item.label,
            apply: item.insertText,
            detail: item.detail,
          })),
        };
      } finally {
        cancellation.dispose();
      }
    };
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown({ base: markdownLanguage, extensions: highlightMarkdown }),
          history(),
          drawSelection(),
          rectangularSelection(),
          EditorState.allowMultipleSelections.of(true),
          closeBrackets(),
          search({ top: true }),
          foldGutter(),
          syntaxHighlighting(defaultHighlightStyle),
          atomicMarkdownSyntax,
          atomicEditorTheme,
          EditorView.lineWrapping,
          inlinePreview({ onLinkClick: (target) => proxy.open(target) }),
          previews(proxy),
          hoverTooltip(
            (view, position) => {
              const link = noteMetadata(view.state.doc.toString()).links.find(
                (link) => position >= link.from && position <= link.to,
              );
              if (!link) return null;
              const asset = proxy.asset(link.target);
              if (!asset) return null;
              return {
                pos: link.from,
                end: link.to,
                above: true,
                create() {
                  const dom = document.createElement("div");
                  dom.className = "vault-link-preview";
                  if (asset.mime === "text/markdown")
                    dom.innerHTML = safeHTML(
                      marked.parse(
                        embeddedText(
                          asset.text ?? "",
                          link.target.split("#")[1],
                        ),
                        { async: false },
                      ),
                    );
                  else if (asset.mime.startsWith("image/") && asset.url) {
                    const image = document.createElement("img");
                    image.src = asset.url;
                    image.alt = link.target;
                    dom.append(image);
                  } else
                    dom.textContent = asset.text?.slice(0, 2000) ?? link.target;
                  dom.onclick = (event) => {
                    event.preventDefault();
                    proxy.open(link.target);
                  };
                  return { dom };
                },
              };
            },
            { hoverTime: 400 },
          ),
          wikiLinks({
            suggest: async (q) => proxy.suggestions(q),
            resolve: async (t) => ({
              target: t,
              label: t,
              status: proxy.asset(t) ? "resolved" : "missing",
            }),
            onOpen: (t) => proxy.open(t),
            openOnClick: true,
          }),
          autocompletion(),
          EditorState.languageData.of(() => [{ autocomplete: completion }]),
          keymap.of([
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...markdownKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          ...(vimMode ? [vim()] : []),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown editor",
            "aria-multiline": "true",
            role: "textbox",
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(external))
            )
              latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    if (reveal) {
      const position = value
        .toLowerCase()
        .indexOf(reveal.replace(/^\^/, "").toLowerCase());
      if (position >= 0)
        editor.dispatch({
          selection: { anchor: position },
          effects: EditorView.scrollIntoView(position, { y: "center" }),
        });
    }
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [vimMode]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      });
  }, [value]);
  return <div ref={parent} className="vault-markdown" />;
}
