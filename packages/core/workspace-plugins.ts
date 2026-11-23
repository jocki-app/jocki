import type { Replica } from "./replica";
import { WorkspaceSettings, type PluginSelection } from "./workspace-settings";
export type { PluginSelection } from "./workspace-settings";
/** Workspace settings are authoritative; local package caches never seed these choices. */
export class WorkspacePlugins {
  constructor(readonly replica: Replica) {}
  choices(): Map<string, PluginSelection> {
    return new Map(
      Object.entries(new WorkspaceSettings(this.replica).read().plugins),
    );
  }
  set(id: string, selection: PluginSelection) {
    return new WorkspaceSettings(this.replica).setPlugin(id, selection);
  }
}
