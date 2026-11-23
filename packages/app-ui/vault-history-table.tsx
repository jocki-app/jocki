import { RotateCcw, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../ui/primitives/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../ui/primitives/table";
export interface HistoryTableRow {
  hash: string;
  description: string;
  event: string;
  time: number;
  changes:
    { added: number; removed: number } | { before: number; after: number };
}
export function HistoryTable<T extends HistoryTableRow>({
  versions,
  selected,
  onSelect,
  onRestore,
  onDelete,
  onReset,
  busy = false,
}: {
  versions: T[];
  selected?: string;
  onSelect?(version: T): void;
  onRestore?(version: T): void;
  onDelete?(version: T): void;
  onReset?(): void;
  busy?: boolean;
}) {
  return (
    <Table aria-label="Retained versions" className="min-w-[36rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Changes</TableHead>
          {(onRestore || onDelete || onReset) && (
            <TableHead className="text-right">
              {onReset ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reset history"
                  title="Reset history to the current saved contents"
                  disabled={busy}
                  onClick={onReset}
                >
                  <RefreshCw />
                </Button>
              ) : (
                "Actions"
              )}
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map((version) => (
          <TableRow
            key={version.hash}
            data-history-version={version.hash}
            data-state={selected === version.hash ? "selected" : undefined}
            aria-selected={onSelect ? selected === version.hash : undefined}
            tabIndex={onSelect ? 0 : undefined}
            className={
              onSelect
                ? "cursor-pointer focus-visible:outline focus-visible:outline-ring"
                : undefined
            }
            onClick={() => onSelect?.(version)}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === "Enter" || event.key === " ")
              ) {
                event.preventDefault();
                onSelect?.(version);
              }
            }}
          >
            <TableCell
              className="max-w-48 whitespace-normal"
              title={version.description || undefined}
            >
              <span className="line-clamp-2 font-medium">
                {version.description || (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {version.time ? (
                <time dateTime={new Date(version.time * 1000).toISOString()}>
                  <span className="block">
                    {new Date(version.time * 1000).toLocaleDateString()}
                  </span>
                  {new Date(version.time * 1000).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-xs">{version.event}</TableCell>
            <TableCell className="font-mono text-xs">
              {"added" in version.changes ? (
                <span title="Characters added and removed">
                  <span className="text-emerald-700 dark:text-emerald-400">
                    +{version.changes.added.toLocaleString()}
                  </span>{" "}
                  <span className="text-red-700 dark:text-red-400">
                    −{version.changes.removed.toLocaleString()}
                  </span>
                  <span className="ml-1 text-muted-foreground">chars</span>
                </span>
              ) : (
                <span>
                  {version.changes.before.toLocaleString()} →{" "}
                  {version.changes.after.toLocaleString()} bytes
                </span>
              )}
            </TableCell>
            {(onRestore || onDelete || onReset) && (
              <TableCell>
                <div className="flex justify-end gap-1">
                  {onRestore && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Restore version"
                      title="Restore version to draft"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRestore(version);
                      }}
                    >
                      <RotateCcw />
                    </Button>
                  )}
                  {onDelete && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete version"
                      title="Delete version and replay later changes"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(version);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
