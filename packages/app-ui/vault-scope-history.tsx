import { rewriteItemHistory } from "./vault-history-actions";
import { RotateCcw } from "lucide-react";
import { useReportedError } from "./errors";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { FileVault, FileHistoryVersion } from "../core/vaults/vault";
import { historyLabel, textChangeSize } from "../core/vaults/history";
import { utf8 } from "../core/crypto";
import { Button } from "../ui/primitives/button";
import type { FeatureTarget } from "./vault-feature-model";
import { FeatureControl } from "./vault-feature-controls";
import { FeatureOverview } from "./vault-feature-overview";
import { HistoryOverview } from "./vault-history-overview";
const HistoryDiff = lazy(() => import("./vault-history-diff"));

export function VaultScopeHistory({
  runtime,
  vault,
  path = "",
  onOpen,
}: {
  runtime: VaultRuntime;
  vault?: FileVault;
  path?: string;
  onOpen(target: FeatureTarget): void;
}) {
  const workspace = useSyncExternalStore(
    (listener) => runtime.workspace.subscribe(listener),
    () => runtime.workspace.current,
  );
  useSyncExternalStore(
    (listener) => vault?.subscribe(listener) ?? (() => {}),
    () => vault?.version ?? 0,
  );
  const [, report] = useReportedError("folder-history");
  const [diff, setDiff] = useState<string>();
  const [busy, setBusy] = useState(false);
  const versions: FileHistoryVersion[] = (() => {
    if (vault) return vault.folderHistory(path).reverse();
    if (!runtime.workspace.features.history) return [];
    let previous = "";
    return runtime.workspace
      .history()
      .map((version) => {
        const json = JSON.stringify(
          runtime.workspace.historySnapshot(version.hash),
          null,
          2,
        );
        const row = {
          ...version,
          ...historyLabel(version.message || "Workspace settings"),
          heads: [version.hash],
          bytes: utf8.encode(json),
          changes: textChangeSize(previous, json),
        };
        previous = json;
        return row;
      })
      .reverse();
  })();
  const version =
    versions.find((version) => version.hash === diff) ?? versions[0];
  if (diff && version)
    return (
      <Suspense fallback={<p>Loading diff…</p>}>
        <HistoryDiff
          version={version}
          current={
            vault
              ? vault.folderCurrent(path)
              : JSON.stringify(workspace, null, 2)
          }
          restore={
            vault ? (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Restore folder version"
                title="Restore folder version"
                onClick={() => {
                  void vault.restoreFolder(path, version.heads).catch(report);
                }}
              >
                <RotateCcw />
              </Button>
            ) : undefined
          }
          language="json"
          onBack={() => setDiff(undefined)}
        />
      </Suspense>
    );
  return (
    <FeatureOverview
      runtime={runtime}
      vault={vault}
      path={path}
      feature="history"
      onOpen={onOpen}
    >
      <HistoryOverview
        versions={versions}
        busy={
          busy ||
          (!vault && runtime.workspace.historyOperationPending) ||
          !!(
            vault &&
            vault.folderDocument(path) &&
            vault.getFreeze(vault.folderDocument(path)!.id)?.rewrite
          )
        }
        onDelete={(version) => {
          setBusy(true);
          void rewriteItemHistory(
            runtime,
            { vault, path },
            { kind: "drop", hash: version.hash },
          )
            .catch(report)
            .finally(() => setBusy(false));
        }}
        onReset={() => {
          setBusy(true);
          void rewriteItemHistory(
            runtime,
            { vault, path },
            { kind: "reset", time: Math.floor(Date.now() / 1000) },
          )
            .catch(report)
            .finally(() => setBusy(false));
        }}
        onDiff={(version) => setDiff(version.hash)}
        control={
          <FeatureControl
            runtime={runtime}
            vault={vault}
            path={path}
            feature="history"
          />
        }
      />
    </FeatureOverview>
  );
}
