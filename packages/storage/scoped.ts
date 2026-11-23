import type { DurableStorage } from "./index";
import type { DuckStorage } from "./duckdb";
import type { ProjectionBatch } from "../core/projection";

/** Local device state and workspace projections occupy separate database files. */
export abstract class ScopedDuckStorage implements DurableStorage {
  private opened = new Map<string, Promise<DuckStorage>>();
  private closed = false;
  protected abstract openScope(scope: string): Promise<DuckStorage>;
  protected abstract scopes(): Promise<string[]>;
  protected abstract removeScope(scope: string): Promise<void>;
  protected scope(key: string) {
    return /^workspace\/([0-9a-f-]{36})\//.exec(key)?.[1] ?? "device";
  }
  private store(scope: string) {
    if (scope !== "device" && !/^[0-9a-f-]{36}$/.test(scope))
      throw Error("Invalid database scope");
    if (this.closed) throw Error("Device storage is closed");
    let value = this.opened.get(scope);
    if (!value) {
      value = this.openScope(scope);
      this.opened.set(scope, value);
      void value.catch(() => this.opened.delete(scope));
    }
    return value;
  }
  async get(key: string) {
    const scope = this.scope(key);
    if (!this.opened.has(scope) && !(await this.scopes()).includes(scope))
      return;
    return (await this.store(scope)).get(key);
  }
  async set(key: string, bytes: Uint8Array) {
    return (await this.store(this.scope(key))).set(key, bytes);
  }
  async getMany(keys: string[]) {
    const groups = new Map<string, string[]>();
    for (const key of keys) {
      const scope = this.scope(key);
      const group = groups.get(scope) ?? [];
      group.push(key);
      groups.set(scope, group);
    }
    const entries: import("./index").StoredEntry[] = [];
    for (const [scope, group] of groups)
      if (this.opened.has(scope) || (await this.scopes()).includes(scope))
        entries.push(...(await (await this.store(scope)).getMany(group)));
    return entries;
  }
  async projectionCheckpoints(id: string) {
    return (await this.store(id)).projectionCheckpoints(id);
  }
  async applyProjection(id: string, batch: ProjectionBatch) {
    return (await this.store(id)).applyProjection(id, batch);
  }
  async delete(key: string) {
    return (await this.store(this.scope(key))).delete(key);
  }
  async keys(prefix: string) {
    const workspace = /^workspace\/([0-9a-f-]{36})\//.exec(prefix)?.[1];
    if (workspace) {
      if (
        !this.opened.has(workspace) &&
        !(await this.scopes()).includes(workspace)
      )
        return [];
      return (await this.store(workspace)).keys(prefix);
    }
    if (prefix.startsWith("device/"))
      return (await this.store("device")).keys(prefix);
    const all = new Set([
      "device",
      ...(await this.scopes()),
      ...this.opened.keys(),
    ]);
    return (
      await Promise.all(
        [...all].map(async (scope) => (await this.store(scope)).keys(prefix)),
      )
    )
      .flat()
      .sort();
  }
  async snapshot(prefix = "") {
    const workspace = /^workspace\/([0-9a-f-]{36})\//.exec(prefix)?.[1];
    if (workspace) {
      if (
        !this.opened.has(workspace) &&
        !(await this.scopes()).includes(workspace)
      )
        return {};
      return (await this.store(workspace)).snapshot(prefix);
    }
    const values: Record<string, Uint8Array> = {};
    for (const key of await this.keys(prefix)) {
      const bytes = await this.get(key);
      if (bytes) values[key] = bytes;
    }
    return values;
  }
  protected async closeScope(scope: string) {
    const store = this.opened.get(scope);
    this.opened.delete(scope);
    if (store) await (await store).close();
  }
  async closeWorkspace(id: string) {
    await this.closeScope(id);
  }
  async deleteWorkspace(id: string) {
    await this.closeWorkspace(id);
    await this.removeScope(id);
  }
  async close() {
    this.closed = true;
    for (const value of this.opened.values()) await (await value).close();
    this.opened.clear();
  }
}
