import {
  useEffect,
  useState,
  Component,
  type ReactNode,
  type ErrorInfo,
} from "react";
import {
  reportSyncError,
  subscribeSyncErrors,
  syncDiagnostics,
  publishSyncDiagnostic,
  type SyncDiagnostic,
} from "../sync/errors";
import { notify } from "../ui/notifications";
import { Button } from "../ui/primitives/button";

export const diagnosticStorageKey = "jocki.local-diagnostics";
function savedDiagnostics(): SyncDiagnostic[] {
  try {
    const saved = JSON.parse(
      localStorage.getItem(diagnosticStorageKey) ?? "[]",
    );
    return Array.isArray(saved)
      ? saved
          .slice(-20)
          .filter((item) => item?.id && item.context && item.error)
      : [];
  } catch {
    return [];
  }
}
function summary(entry: SyncDiagnostic) {
  const error = entry.error as { message?: string; kind?: string };
  const message = error.message ?? "Operation failed";
  return /\[[A-Z_]+\]:/.test(message)
    ? message
    : `${entry.context.phase} [${error.kind ?? "FAILED"}]: ${message}`;
}
/** Local, bounded diagnostics survive a WebView restart and never enter sync. */
export function Diagnostics({ floating = false }: { floating?: boolean }) {
  const [entries, setEntries] = useState<SyncDiagnostic[]>([]);
  useEffect(() => {
    for (const entry of savedDiagnostics()) publishSyncDiagnostic(entry);
    const persist = (values: SyncDiagnostic[]) => {
      const recent = values.slice(-20);
      setEntries(recent);
      try {
        localStorage.setItem(diagnosticStorageKey, JSON.stringify(recent));
      } catch {
        /* A full diagnostic cache cannot prevent workspace access. */
      }
    };
    persist(syncDiagnostics());
    const unsubscribe = subscribeSyncErrors((entry) => {
      persist(syncDiagnostics());
      if (entry.disposition === "failure") notify.error(summary(entry));
    });
    const error = (event: ErrorEvent) => {
      reportSyncError(
        event.error ?? { message: event.message, name: "WindowError" },
        { phase: "app-render" },
      );
    };
    const rejection = (event: PromiseRejectionEvent) => {
      reportSyncError(event.reason, { phase: "unhandled-promise" });
    };
    window.addEventListener("error", error);
    window.addEventListener("unhandledrejection", rejection);
    return () => {
      unsubscribe();
      window.removeEventListener("error", error);
      window.removeEventListener("unhandledrejection", rejection);
    };
  }, []);
  if (!entries.length) return null;
  const copy = async () => {
    if (!navigator.clipboard?.writeText)
      throw Error(
        "Clipboard access is unavailable. You can select and copy the diagnostic details below.",
      );
    await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
    notify.success("Diagnostics copied.");
  };
  return (
    <details
      className={`${floating ? "fixed z-50 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4" : "mx-auto my-4"} w-[calc(100vw-2rem)] max-w-lg rounded-md border bg-background p-3 shadow-lg`}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Recent errors ({entries.length})
      </summary>
      <div className="mt-3 max-h-[55dvh] space-y-3 overflow-auto break-words text-sm">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copy().catch(notify.error)}
          >
            Copy diagnostics
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEntries([]);
              localStorage.removeItem(diagnosticStorageKey);
            }}
          >
            Clear
          </Button>
        </div>
        {[...entries].reverse().map((entry) => (
          <details key={entry.id} className="rounded border p-2">
            <summary className="cursor-pointer">{summary(entry)}</summary>
            <p className="mt-2 text-xs text-muted-foreground">
              {entry.at} · {entry.id}
            </p>
            <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(entry, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </details>
  );
}

export class ApplicationBoundary extends Component<
  { children: ReactNode },
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError() {
    return { error: "The app view could not be displayed." };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    const failure = reportSyncError(error, { phase: "app-render" });
    this.setState({ error: failure.message });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="mx-auto max-w-xl space-y-4 p-6 pt-[calc(2rem+env(safe-area-inset-top))]">
        <p role="alert" className="break-words">
          {this.state.error}
        </p>
        <p>
          Your saved workspace is retained. Details are available in Recent
          errors.
        </p>
        <Button
          onClick={() => {
            localStorage.removeItem("jocki.active-workspace");
            location.reload();
          }}
        >
          Back to workspaces
        </Button>
      </main>
    );
  }
}
