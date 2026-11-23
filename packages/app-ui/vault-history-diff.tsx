import { lazy, Suspense, useState, type ReactNode } from "react";
import { ArrowLeft, WrapText } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Toggle } from "../ui/primitives/toggle";
import { HistoryTable } from "./vault-history-table";
import type { FileHistoryVersion } from "../core/vaults/vault";
const DiffEditor = lazy(() => import("./vault-history-diff-editor"));

/** The diff screen: back navigation, one version row and restore, without scope controls. */
export default function HistoryDiff({
  version,
  current,
  language = "plaintext",
  binary = false,
  currentBytes = 0,
  restore,
  recovery,
  onBack,
}: {
  version: FileHistoryVersion;
  current: string;
  language?: string;
  binary?: boolean;
  currentBytes?: number;
  restore?: ReactNode;
  recovery?: ReactNode;
  onBack(): void;
}) {
  const [wrap, setWrap] = useState(true);
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden"
      data-history-detail
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label="Back to versions"
            title="Back to versions"
          >
            <ArrowLeft />
          </Button>
          {restore}
        </div>
        {!binary && (
          <Toggle
            size="sm"
            variant="outline"
            className="size-7 p-0"
            aria-label="Wrap lines"
            title={wrap ? "Disable line wrapping" : "Enable line wrapping"}
            pressed={wrap}
            onPressedChange={setWrap}
          >
            <WrapText />
          </Toggle>
        )}
      </div>
      <div className="min-w-0 shrink-0">
        <HistoryTable versions={[version]} />
      </div>
      {recovery && <div className="shrink-0">{recovery}</div>}
      {binary ? (
        <p className="min-h-0 flex-1 overflow-auto text-sm">
          Selected version: {version.bytes.byteLength.toLocaleString()} bytes.
          Current file: {currentBytes.toLocaleString()} bytes.
        </p>
      ) : (
        <Suspense
          fallback={
            <p className="min-h-0 flex-1 p-6 text-sm text-muted-foreground">
              Loading diff…
            </p>
          }
        >
          <DiffEditor
            original={new TextDecoder().decode(version.bytes)}
            modified={current}
            language={language}
            wrap={wrap}
          />
        </Suspense>
      )}
    </div>
  );
}
