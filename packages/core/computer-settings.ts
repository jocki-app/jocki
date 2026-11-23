import type { DocHandle } from "@automerge/automerge-repo";
import type { Repository } from "./repository";
import { invariant } from "@jocki/platform/core/errors";
export interface ComputerSettingsDocument {
  format: "jocki-computer-settings";
  workspaceId: string;
  computerId: string;
  values: Record<string, unknown>;
}
/** Private to this computer identity. Not granted to the workspace group or exported. */
export class ComputerSettings {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly handle: DocHandle<ComputerSettingsDocument>,
    private repository: Repository,
  ) {}
  get<T = unknown>(key: string): T | undefined {
    const value = this.handle.doc()!.values[key];
    return value === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(value)) as T);
  }
  set(key: string, value: unknown) {
    invariant(
      key.length > 0 && key.length <= 256,
      "INVALID_SETTINGS",
      "Invalid computer setting key",
    );
    const next = this.queue.then(async () => {
      const copy = JSON.parse(JSON.stringify(value));
      this.handle.change((doc) => {
        doc.values[key] = copy;
      });
      await this.repository.flush();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async flush() {
    await this.queue;
    await this.repository.flush();
  }
}
