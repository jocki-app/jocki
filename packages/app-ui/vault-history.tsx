import { rewriteItemHistory } from "./vault-history-actions";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { RotateCcw } from "lucide-react";
import { useReportedError } from "./errors";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import type { FileVault, FileHistoryVersion } from "../core/vaults/vault";
import { fileText } from "../core/vaults/vault";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { FeatureTarget } from "./vault-feature-model";
import { FeatureControl } from "./vault-feature-controls";
import { FeatureOverview } from "./vault-feature-overview";
import { HistoryOverview } from "./vault-history-overview";
const HistoryDiff = lazy(() => import("./vault-history-diff"));
function LoadedHistory({
  vault,
  id,
  restore,
  recovered,
  runtime,
  onOpen,
}: {
  vault: FileVault;
  id: string;
  restore(heads: string[]): void;
  recovered(id: string): Promise<void>;
  runtime: VaultRuntime;
  onOpen(target: FeatureTarget): void;
}) {
  useSyncExternalStore(
    (listener) => vault.subscribe(listener),
    () => vault.version,
  );
  const versions = vault.historyEnabled(id) ? vault.history(id).reverse() : [],
    entry = vault.entry(id);
  const [diff, setDiff] = useState<string>(),
    [path, setPath] = useState(entry.path),
    [, setError] = useReportedError("vault-history"),
    [busy, setBusy] = useState(false);
  const version = versions.find((v) => v.hash === diff) ?? versions[0];
  const binary = vault.doc(id).kind === "binary";
  const restoreAction = (version: FileHistoryVersion) =>
    entry.deleted ? (
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Save recovered copy"
        title="Save recovered copy"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void vault
            .recoverCopy(id, path, version.heads)
            .then(recovered)
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        <RotateCcw />
      </Button>
    ) : (
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Restore version to draft"
        title="Restore version to draft"
        onClick={() => restore(version.heads)}
      >
        <RotateCcw />
      </Button>
    );
  return (
    <div className="vault-history" data-file-history>
      {diff && version ? (
        <Suspense fallback={<p>Loading diff…</p>}>
          <HistoryDiff
            version={version}
            current={fileText(vault.doc(id))}
            binary={binary}
            currentBytes={vault.doc(id).bytes.byteLength}
            language={entry.path.endsWith(".md") ? "markdown" : "plaintext"}
            restore={restoreAction(version)}
            recovery={
              entry.deleted ? (
                <div className="space-y-3">
                  <label className="block space-y-2 text-sm">
                    Recovered file path
                    <Input
                      aria-label="Recovered file path"
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Recovery creates a new file identity at this path.
                  </p>
                </div>
              ) : undefined
            }
            onBack={() => setDiff(undefined)}
          />
        </Suspense>
      ) : (
        <FeatureOverview
          runtime={runtime}
          vault={vault}
          id={id}
          path={entry.path}
          feature="history"
          onOpen={onOpen}
        >
          <HistoryOverview
            versions={versions}
            busy={busy || !!vault.getFreeze(id)?.rewrite}
            onDelete={(version) => {
              setBusy(true);
              void rewriteItemHistory(
                runtime,
                { vault, id, path: entry.path },
                { kind: "drop", hash: version.hash },
              )
                .catch(setError)
                .finally(() => setBusy(false));
            }}
            onReset={() => {
              setBusy(true);
              void rewriteItemHistory(
                runtime,
                { vault, id, path: entry.path },
                { kind: "reset", time: Math.floor(Date.now() / 1000) },
              )
                .catch(setError)
                .finally(() => setBusy(false));
            }}
            onDiff={(v) => setDiff(v.hash)}
            onRestore={(v) =>
              entry.deleted ? setDiff(v.hash) : restore(v.heads)
            }
            control={
              <FeatureControl
                runtime={runtime}
                vault={vault}
                id={id}
                feature="history"
              />
            }
          />
        </FeatureOverview>
      )}
    </div>
  );
}

export default function VaultHistory(
  props: Parameters<typeof LoadedHistory>[0],
) {
  const [loaded, setLoaded] = useState(props.vault.isLoaded(props.id));
  const [, setError] = useReportedError("vault-history");
  useEffect(() => {
    let active = true;
    void props.vault
      .load(props.id)
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch(setError);
    return () => {
      active = false;
    };
  }, [props.vault, props.id]);
  return loaded ? <LoadedHistory {...props} /> : <p>Loading history…</p>;
}
