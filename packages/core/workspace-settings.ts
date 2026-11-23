import type { Replica } from "./replica";
import { canonical } from "./crypto";
import { invariant } from "@jocki/platform/core/errors";

export const workspaceSettingsId = "setting/workspace";
export interface PluginSelection {
  installed: boolean;
  enabled: boolean;
}
/** Shared preferences only. Device permissions, files, appearance and navigation state stay local. */
export interface WorkspaceSettingsValue {
  plugins: Record<string, PluginSelection>;
  home: string | null;
}
export const defaultWorkspaceSettings = (): WorkspaceSettingsValue => ({
  plugins: {},
  home: null,
});
export function validateWorkspaceSettings(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & WorkspaceSettingsValue {
  invariant(
    Object.keys(value).every((key) => key === "plugins" || key === "home") &&
      value.plugins !== null &&
      typeof value.plugins === "object" &&
      !Array.isArray(value.plugins) &&
      Object.keys(value.plugins).length <= 1000 &&
      (value.home === null ||
        (typeof value.home === "string" &&
          value.home.length <= 240 &&
          /^(plugins|[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*)$/.test(value.home))),
    "INVALID_WORKSPACE_SETTINGS",
    "Invalid shared workspace settings",
  );
  for (const [id, selection] of Object.entries(
    value.plugins as Record<string, PluginSelection>,
  )) {
    invariant(
      id.length <= 180 &&
        /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/.test(id) &&
        selection &&
        typeof selection === "object" &&
        typeof selection.installed === "boolean" &&
        typeof selection.enabled === "boolean" &&
        (!selection.enabled || selection.installed) &&
        Object.keys(selection).every(
          (key) => key === "installed" || key === "enabled",
        ),
      "INVALID_WORKSPACE_SETTINGS",
      "Invalid workspace plugin selection",
    );
  }
}
export class WorkspaceSettings {
  private static queues = new WeakMap<Replica, Promise<unknown>>();
  constructor(readonly replica: Replica) {}
  read(): WorkspaceSettingsValue {
    const value = this.replica.read(workspaceSettingsId);
    if (!value) return defaultWorkspaceSettings();
    validateWorkspaceSettings(value);
    return value;
  }
  private change(
    edit: (value: WorkspaceSettingsValue) => WorkspaceSettingsValue,
    fields: string[],
  ) {
    const next = (
      WorkspaceSettings.queues.get(this.replica) ?? Promise.resolve()
    ).then(async () => {
      const value = edit(this.read());
      validateWorkspaceSettings(value as unknown as Record<string, unknown>);
      if (
        canonical(value) !==
          canonical(this.replica.read(workspaceSettingsId)) ||
        fields.some(
          (field) =>
            Object.keys(this.replica.conflicts(workspaceSettingsId, field))
              .length > 1,
        )
      )
        await this.replica.update(
          workspaceSettingsId,
          value as unknown as Record<string, unknown>,
          fields,
        );
    });
    WorkspaceSettings.queues.set(
      this.replica,
      next.catch(() => {}),
    );
    return next;
  }
  async set(value: WorkspaceSettingsValue) {
    validateWorkspaceSettings(value as unknown as Record<string, unknown>);
    return this.change(
      () => structuredClone(value),
      ["home", ...Object.keys(value.plugins).map((id) => "plugins." + id)],
    );
  }
  setHome(home: string) {
    return this.change(
      (value) => ({
        ...value,
        home,
      }),
      ["home"],
    );
  }
  setPlugin(id: string, selection: PluginSelection) {
    return this.change(
      (value) => ({
        ...value,
        plugins: { ...value.plugins, [id]: selection },
      }),
      ["plugins." + id],
    );
  }
}
