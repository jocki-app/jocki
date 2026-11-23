import type { FileVault } from "../core/vaults/vault";
import type { VaultRuntime } from "../platform-browser/vault-runtime";

export type UnitFeature = "history" | "sync";
export interface FeatureTarget {
  vault?: FileVault;
  path?: string;
  id?: string;
}
export type ScopeTone = "enabled" | "disabled" | "off";
export type ScopeState = ScopeTone | "inherited";

/** Resolve the policy separately from the hierarchy's quantity-based colors. */
export function featureState(
  runtime: VaultRuntime,
  target: FeatureTarget,
  feature: UnitFeature,
): { state: ScopeState; tone: ScopeTone } {
  const override = (unit: FeatureTarget) =>
    unit.vault
      ? featureOverride(unit, feature)
      : runtime.workspace.current.features[feature];
  const own = override(target);
  if (own !== undefined) {
    const tone = own ? "enabled" : "disabled";
    return { state: tone, tone };
  }
  for (const source of featureAncestors(target).reverse()) {
    const value = override(source);
    if (value !== undefined)
      return { state: "inherited", tone: value ? "enabled" : "disabled" };
  }
  return { state: "off", tone: "off" };
}
export function featureOverride(target: FeatureTarget, feature: UnitFeature) {
  const { vault, path = "", id } = target;
  if (!vault) return undefined;
  const policies = vault.scopePolicies;
  return (
    id ? policies.files[id] : path ? policies.folders[path] : policies.vault
  )?.[feature];
}

/** Include every potential ancestor within the mounted boundary, without sibling branches. */
export function featureAncestors(target: FeatureTarget): FeatureTarget[] {
  const { vault, id } = target;
  if (!vault) return [];
  const path = target.path ?? (id ? vault.entry(id).path : "");
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const parents: FeatureTarget[] = [{}, ...(path ? [{ vault, path: "" }] : [])];
  for (let count = 1; count <= parts.length; count++)
    parents.push({ vault, path: parts.slice(0, count).join("/") });
  return parents;
}
export const featureDialogClass =
  "flex h-[85dvh] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-6xl";
