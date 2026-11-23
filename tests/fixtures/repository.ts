import { openNodeRepository } from "../../packages/platform-node/repository";
import path from "node:path";
import type {
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo";
import type { DurableStorage } from "../../packages/storage";
import { Repository } from "../../packages/core/repository";
/** Test-only in-memory capability; production uses official IndexedDB and filesystem adapters. */
export class TestRepoStorage implements StorageAdapterInterface {
  constructor(
    private readonly storage: DurableStorage,
    private readonly scope: string,
  ) {}
  private key(key: StorageKey) {
    return this.scope + "/" + JSON.stringify(key);
  }
  load(key: StorageKey) {
    return this.storage.get(this.key(key));
  }
  save(key: StorageKey, bytes: Uint8Array) {
    return this.storage.set(this.key(key), bytes);
  }
  remove(key: StorageKey) {
    return this.storage.delete(this.key(key));
  }
  async loadRange(prefix: StorageKey) {
    const result: Awaited<ReturnType<StorageAdapterInterface["loadRange"]>> =
      [];
    for (const entry of await this.storage.keys(this.scope + "/")) {
      const key = JSON.parse(entry.slice(this.scope.length + 1)) as StorageKey;
      if (!prefix.every((part, index) => key[index] === part)) continue;
      const data = await this.storage.get(entry);
      if (data) result.push({ key, data });
    }
    return result;
  }
  async removeRange(prefix: StorageKey) {
    for (const { key } of await this.loadRange(prefix)) await this.remove(key);
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    for (const [key, bytes] of entries) await this.save(key, bytes);
  }
}
export function testRepository(storage: DurableStorage) {
  const directory = (storage as DurableStorage & { directory?: string })
    .directory;
  if (directory) return openNodeRepository(path.join(directory, "automerge"));
  return Repository.open({
    documents: new TestRepoStorage(storage, "repo-documents"),
    identity: new TestRepoStorage(storage, "repo-identity"),
  });
}
