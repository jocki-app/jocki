import type { PluginRegistry } from "@jocki/platform/core/registry";
import { isRequiredCore } from "@jocki/platform/core/catalog";
import { invariant } from "@jocki/platform/core/errors";
import type { PluginSelection } from "./workspace-plugins";

/** Explicit app reconciliation; receiving replica data itself never invokes plugin code. */
export async function reconcilePluginActivation(
  registry: PluginRegistry,
  choices: Map<string, PluginSelection>,
  ensureVerifiedPackage: (id: string) => Promise<void>,
) {
  const installed = new Set<string>(),
    enabled = new Set<string>(),
    visiting = new Set<string>(),
    completed = new Set<string>(),
    errors = new Map<string, string>();
  async function install(id: string, active: boolean) {
    if (isRequiredCore(id)) return;
    invariant(
      !visiting.has(id),
      "DEPENDENCY_CYCLE",
      "Plugin dependencies contain a cycle",
    );
    const choice = choices.get(id);
    invariant(
      choice?.installed !== false && (!active || choice?.enabled !== false),
      "DEPENDENCY_MISSING",
      `Install and enable ${id} in this workspace first`,
    );
    installed.add(id);
    if (active) enabled.add(id);
    const key = id + ":" + active;
    if (completed.has(key)) return;
    visiting.add(id);
    try {
      await ensureVerifiedPackage(id);
      const manifest = registry.manifests.get(id);
      invariant(manifest, "PLUGIN_NOT_FOUND", `Plugin ${id} is unavailable`);
      for (const dependency of manifest.dependencies)
        await install(dependency, active);
      if (
        !registry.states.get(id)?.installed ||
        registry.states.get(id)?.version !== manifest.version
      )
        await registry.install(id);
      if (active && !registry.enabled(id)) await registry.enable(id);
      completed.add(key);
    } finally {
      visiting.delete(id);
    }
  }
  for (const [id, choice] of choices)
    if (choice.installed) {
      try {
        await install(id, choice.enabled);
      } catch (error) {
        errors.set(id, error instanceof Error ? error.message : String(error));
      }
    }
  const unwanted = new Set(
    [...registry.states.values()]
      .filter((s) => s.enabled && !isRequiredCore(s.id) && !enabled.has(s.id))
      .map((s) => s.id),
  );
  while (unwanted.size) {
    let progress = false;
    for (const id of unwanted) {
      if (
        [...registry.manifests.values()].some(
          (m) => registry.enabled(m.id) && m.dependencies.includes(id),
        )
      )
        continue;
      await registry.disable(id);
      unwanted.delete(id);
      progress = true;
    }
    if (!progress) {
      for (const id of unwanted)
        errors.set(id, "An active plugin still depends on this plugin");
      break;
    }
  }
  const removals = new Set(
    [...registry.states.values()]
      .filter(
        (state) =>
          state.installed &&
          !state.enabled &&
          !isRequiredCore(state.id) &&
          !installed.has(state.id),
      )
      .map((state) => state.id),
  );
  while (removals.size) {
    let progress = false;
    for (const id of removals) {
      if (
        [...registry.manifests.values()].some(
          (manifest) =>
            registry.states.get(manifest.id)?.installed &&
            manifest.dependencies.includes(id),
        )
      )
        continue;
      await registry.uninstall(id);
      removals.delete(id);
      progress = true;
    }
    if (!progress) {
      for (const id of removals)
        errors.set(id, "An installed plugin still depends on this plugin");
      break;
    }
  }
  return errors;
}
