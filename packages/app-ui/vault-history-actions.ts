import type { HistoryRewrite } from "../core/vaults/history-rewrite";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { FeatureTarget } from "./vault-feature-model";

/** The UI requests an operation; core owns the durable writer and peer agreement. */
export async function rewriteItemHistory(
  runtime: VaultRuntime,
  target: FeatureTarget,
  operation: HistoryRewrite,
) {
  const { vault, id, path = "" } = target;
  if (!vault)
    return (await runtime.startSync()).rewriteWorkspaceHistory(operation);
  const unit = id ?? vault.folderDocument(path)?.id;
  if (unit && vault.historyProtection(unit))
    return (await runtime.startSync()).rewriteHistory(
      vault,
      { id, path },
      operation,
    );
  return id
    ? vault.rewriteFileHistory(id, operation)
    : vault.rewriteFolderHistory(path, operation);
}
