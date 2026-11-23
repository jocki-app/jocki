import { useId, useRef } from "react";
import { FileText, Search, X } from "lucide-react";
import type { IndexedFile, SearchHit } from "../core/vaults/search";
import { Input } from "../ui/primitives/input";
import { Button } from "../ui/primitives/button";

/** The same compact search surface fits both navigation and a full editor pane. */
export function VaultSearchPane({
  query,
  onQuery,
  hits,
  vaultName,
  onOpen,
}: {
  query: string;
  onQuery(value: string): void;
  hits: SearchHit[];
  vaultName(id: string): string;
  onOpen(file: IndexedFile): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const searched = !!query.trim();
  return (
    <section
      className="flex min-w-0 flex-col"
      aria-label="File search"
      data-file-search
    >
      <div className="sticky top-0 z-10 space-y-3 border-b bg-background p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">Search</h2>
          <span className="text-xs text-muted-foreground">All vaults</span>
        </div>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
          />
          <Input
            ref={input}
            autoFocus
            aria-label="Search all vaults"
            aria-describedby={id + "-help"}
            aria-controls={id + "-results"}
            placeholder="Search files…"
            className="pl-8 pr-8"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                const first = results.current?.querySelector<HTMLButtonElement>(
                  "[data-search-result]",
                );
                if (first) {
                  event.preventDefault();
                  first.focus();
                }
              }
              if (event.key === "Escape" && query) {
                event.preventDefault();
                onQuery("");
              }
            }}
          />
          {!!query && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1.5"
              aria-label="Clear search"
              onClick={() => {
                onQuery("");
                input.current?.focus();
              }}
            >
              <X />
            </Button>
          )}
        </div>
        <details id={id + "-help"} className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Search tips</summary>
          <p className="pt-2 leading-relaxed">
            Use words or “exact phrases”. Narrow with <code>path:</code>,{" "}
            <code>metadata:</code>, <code>type:</code> or <code>mime:</code>.
            Exclude with <code>-word</code>.
          </p>
        </details>
      </div>
      <div className="px-3 py-2 text-xs text-muted-foreground" role="status">
        {searched
          ? `${hits.length === 100 ? "100+" : hits.length} matching ${hits.length === 1 ? "file" : "files"}`
          : "Search file names and contents"}
      </div>
      <div
        ref={results}
        id={id + "-results"}
        className="min-w-0 px-1 pb-3"
        onKeyDown={(event) => {
          const buttons = [
            ...(results.current?.querySelectorAll<HTMLButtonElement>(
              "[data-search-result]",
            ) ?? []),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (event.key === "ArrowUp" && index === 0) input.current?.focus();
            else
              buttons[
                Math.max(
                  0,
                  Math.min(
                    buttons.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                )
              ]?.focus();
          }
        }}
      >
        {searched &&
          hits.map(({ file, excerpt }) => {
            const parts = file.path.split("/"),
              name = parts.pop()!;
            return (
              <Button
                key={file.vault + "/" + file.id}
                variant="ghost"
                className="h-auto w-full min-w-0 items-start justify-start gap-2 rounded-md px-2 py-3 text-left whitespace-normal"
                data-search-result
                title={vaultName(file.vault) + " / " + file.path}
                onClick={() => onOpen(file)}
              >
                <FileText
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span className="block min-w-0 flex-1 space-y-1">
                  <span className="block truncate text-sm font-medium">
                    {name}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {[vaultName(file.vault), ...parts].join(" / ")}
                  </span>
                  {!!excerpt && (
                    <span className="line-clamp-2 text-xs font-normal leading-relaxed break-words text-muted-foreground">
                      {excerpt}
                    </span>
                  )}
                </span>
              </Button>
            );
          })}
        {searched && !hits.length && (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No matching files</p>
            <p className="mt-1 text-xs">Try fewer words or remove a filter.</p>
          </div>
        )}
      </div>
    </section>
  );
}
