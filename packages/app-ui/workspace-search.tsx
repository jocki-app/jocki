import { notify } from "../ui/notifications";
import { LoadingSpinner } from "../ui/loading-spinner";
import { useEffect, useState } from "react";
import { useLiveQuery } from "../data-duckdb/react";
import { ArrowRight } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
  CommandGroup,
} from "../ui/primitives/command";
import { PluginIcon, pageRoute, type NavPlugin } from "./navigation";
import type { AppRuntime } from "./runtime";
import type { SearchDocument } from "@jocki/platform/plugin-sdk/navigation";
import { searchText } from "./search-index";

function commandAvailable(enabled?: () => boolean) {
  try {
    return !enabled || enabled();
  } catch {
    return false;
  }
}

export function WorkspaceSearchDialog({
  runtime,
  entries,
  open,
  onOpenChange,
  navigate,
  embedded = false,
}: {
  runtime: AppRuntime;
  entries: NavPlugin[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (route: string) => void;
  embedded?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<SearchDocument[]>([]),
    [busy, setBusy] = useState(false);
  // Cache writes notify live queries too. Only actual record changes should
  // restart the search, otherwise indexing can cancel its own result forever.
  const revision = useLiveQuery(
    async () => JSON.stringify(await runtime.db.records.toArray()),
    [runtime],
  );
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      void runtime.search
        .query(query)
        .then((rows) => {
          if (!canceled) {
            setResults(rows);
          }
        })
        .catch((e) => {
          if (!canceled) notify.error(e);
        })
        .finally(() => {
          if (!canceled) setBusy(false);
        });
    }, 100);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [runtime, open, query, revision, runtime.surfacesVersion]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);
  const commands = [
    ...entries
      .filter((plugin) => plugin.enabled !== false)
      .flatMap((plugin) =>
        [plugin.main, ...plugin.pages].map((page) => ({
          id: "navigate:" + pageRoute(plugin, page),
          title:
            "Open " +
            plugin.label +
            (page === plugin.main ? "" : " · " + page.label),
          pluginId: plugin.id,
          keywords: [],
          run: () => navigate(pageRoute(plugin, page)),
        })),
      ),
    ...[...runtime.commands.values()].filter(
      (c) =>
        runtime.registry.enabled(c.pluginId) && commandAvailable(c.enabled),
    ),
  ].filter((c) =>
    searchText(c.title + " " + c.keywords?.join(" ")).includes(
      searchText(query).trim(),
    ),
  );
  const execute = async (run: () => unknown) => {
    setBusy(true);
    try {
      await run();
      onOpenChange(false);
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  };
  const content = (
    <Command
      shouldFilter={false}
      className={embedded ? "rounded-lg border" : undefined}
    >
      <CommandInput
        aria-label="Search content and commands"
        placeholder="Search content and commands…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList aria-busy={busy}>
        <CommandEmpty>
          {busy ? <LoadingSpinner label="Searching…" /> : "No results found."}
        </CommandEmpty>
        {results.length > 0 && (
          <CommandGroup heading="Content">
            {results.map((result) => (
              <CommandItem
                key={result.id}
                value={"record:" + result.id}
                onSelect={() =>
                  void execute(() =>
                    runtime.navigate(
                      result.pluginId,
                      runtime.searchOptions.get(result.collection)?.page,
                      result.id,
                    ),
                  )
                }
              >
                <PluginIcon id={result.pluginId} />
                <span className="min-w-0 flex-1 truncate">{result.title}</span>
                <span className="text-xs text-muted-foreground">
                  {result.collection}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {commands.length > 0 && (
          <CommandGroup heading="Commands">
            {commands.slice(0, 30).map((command) => (
              <CommandItem
                key={command.id}
                value={command.id}
                disabled={busy}
                onSelect={() => void execute(command.run)}
              >
                <PluginIcon id={command.pluginId} />
                <span>{command.title}</span>
                <ArrowRight className="ml-auto" />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
  return embedded ? (
    content
  ) : (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search workspace"
      description="Search content and commands on this device"
    >
      {content}
    </CommandDialog>
  );
}
