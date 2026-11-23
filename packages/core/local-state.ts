import type { Replica } from "./replica";
import { utf8, text } from "./crypto";
/** Device-local checkpoints. Never replicated or interpreted as incoming commands. */
export class LocalState {
  private static queues = new WeakMap<Replica, Map<string, Promise<unknown>>>();
  constructor(
    readonly replica: Replica,
    readonly namespace: string,
  ) {}
  private key(id: string) {
    return `workspace/${this.replica.workspaceId}/local/${this.namespace}/${id}`;
  }
  async get<T>(id: string): Promise<T | undefined> {
    const value = await this.replica.storage.get(this.key(id));
    return value ? (JSON.parse(text.decode(value)) as T) : undefined;
  }
  async update<T>(
    id: string,
    change: (prior: T | undefined) => T | Promise<T>,
  ): Promise<T> {
    let queues = LocalState.queues.get(this.replica);
    if (!queues) LocalState.queues.set(this.replica, (queues = new Map()));
    const key = this.key(id),
      work = (queues.get(key) ?? Promise.resolve()).then(async () => {
        const value = await change(await this.get<T>(id));
        await this.replica.storage.set(key, utf8.encode(JSON.stringify(value)));
        return value;
      });
    queues.set(
      key,
      work.catch(() => {}),
    );
    return work;
  }
  async set(id: string, value: unknown) {
    await this.update(id, () => value);
  }
  async ids() {
    const prefix = this.key("");
    return (await this.replica.storage.keys(prefix)).map((key) =>
      key.slice(prefix.length),
    );
  }
}
