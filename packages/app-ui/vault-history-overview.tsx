import { History } from "lucide-react";
import type { ReactNode } from "react";
import type { FileHistoryVersion } from "../core/vaults/vault";
import { HistoryTable } from "./vault-history-table";

/** The overview pane contains only the versions table, on every screen size. */
export function HistoryOverview({
  versions,
  onDiff,
  onRestore,
  control,
  onDelete,
  onReset,
  busy,
}: {
  versions: FileHistoryVersion[];
  onDiff(version: FileHistoryVersion): void;
  onRestore?(version: FileHistoryVersion): void;
  control: ReactNode;
  onDelete?(version: FileHistoryVersion): void;
  onReset?(): void;
  busy?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-history-overview>
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
        data-history-versions
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <History className="size-4" /> Versions{" "}
            <span className="text-muted-foreground">{versions.length}</span>
          </h2>
          {control}
        </div>
        {versions.length ? (
          <div className="min-h-0 overflow-auto rounded-lg border">
            <HistoryTable
              versions={versions}
              onSelect={onDiff}
              onRestore={onRestore}
              onDelete={onDelete}
              onReset={onReset}
              busy={busy}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No retained versions.</p>
        )}
      </section>
    </div>
  );
}
