import type { ShareSummary } from "../core/vaults/protected-sync";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { FeatureTarget } from "./vault-feature-model";

export const scopeCountKey = ({ vault, path = "", id }: FeatureTarget) =>
  vault ? `${vault.id}\0${id ? "file:" + id : "folder:" + path}` : "workspace";

/** Match the rollback rows shown by the item's History overview, without building diffs. */
export async function rollbackVersionCount(
  runtime: VaultRuntime,
  target: FeatureTarget,
) {
  if (!target.vault) return runtime.workspace.historyVersionCount();
  return target.id
    ? target.vault.historyVersionCount(target.id)
    : target.vault.folderHistoryVersionCount(target.path ?? "");
}

export function shareRowEnabled(runtime: VaultRuntime, share: ShareSummary) {
  if (share.invitation.kind === "workspace")
    return runtime.workspace.current.features.sync === true;
  const vault = share.vault && runtime.vaults.get(share.vault);
  if (!vault) return false;
  const own =
    share.invitation.kind === "file"
      ? vault.scopePolicies.files[share.rootFile!]?.sync
      : share.prefix
        ? vault.scopePolicies.folders[share.prefix]?.sync
        : vault.scopePolicies.vault.sync;
  return own === true || share.inherited === true;
}

/** Index scope rows once; each item only visits its own ancestor prefixes. */
export function effectiveShareCounter(
  runtime: VaultRuntime,
  shares: readonly ShareSummary[],
  broadcast: boolean,
) {
  let workspace = 0;
  const prefixes = new Map<string, number>(),
    files = new Map<string, number>();
  const seen = new Set<string>();
  const add = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);
  for (const share of shares) {
    if (
      !broadcast ||
      !share.broadcast ||
      !shareRowEnabled(runtime, share) ||
      seen.has(share.invitation.url)
    )
      continue;
    seen.add(share.invitation.url);
    if (share.invitation.kind === "workspace") workspace++;
    else if (share.vault && runtime.vaults.has(share.vault)) {
      if (share.invitation.kind === "file") {
        if (share.rootFile) add(files, `${share.vault}\0${share.rootFile}`);
      } else add(prefixes, `${share.vault}\0${share.prefix}`);
    }
  }
  return ({ vault, path = "", id }: FeatureTarget) => {
    if (!vault) return runtime.workspace.features.sync ? workspace : 0;
    if (!(id ? vault.syncEnabled(id) : vault.folderFeatures(path).sync))
      return 0;
    let count = workspace + (prefixes.get(`${vault.id}\0`) ?? 0);
    const location = id ? vault.entry(id).path : path;
    const parts = location.split("/").filter(Boolean);
    for (let length = 1; length <= parts.length; length++)
      count +=
        prefixes.get(`${vault.id}\0${parts.slice(0, length).join("/")}`) ?? 0;
    return count + (id ? (files.get(`${vault.id}\0${id}`) ?? 0) : 0);
  };
}

/** Positive counts occupy the full bounded green range; zero has a neutral fill. */
export function scopeColorRatio(count: number, maximum: number) {
  return count <= 0 || maximum <= 0
    ? 0
    : maximum === 1
      ? 1
      : (count - 1) / (maximum - 1);
}
