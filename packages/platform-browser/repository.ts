import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { initializeWasm } from "@automerge/automerge/slim";
import automergeWasm from "@automerge/automerge/automerge.wasm?url";
import { repositorySettings } from "./repository-settings";
import { relayConnection } from "../core/relay-settings";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { Repository, type RepositoryOptions } from "../core/repository";
import type { StorageAdapterInterface } from "@automerge/automerge-repo";
let initialized: Promise<void> | undefined;
export async function openBrowserRepository(
  name = "jocki-repo",
  options: Omit<RepositoryOptions, "documents" | "identity"> = {},
) {
  await (initialized ??= initializeWasm(automergeWasm));
  const native = window.jockiNative?.repository;
  const adapter = (
    bucket: "documents" | "identity",
  ): StorageAdapterInterface => ({
    load: async (key) =>
      (await native!.storage(bucket, "load", key)) as Uint8Array | undefined,
    saveBatch: (entries) => native!.batch(bucket, entries),
    save: async (key, bytes) => {
      await native!.storage(bucket, "save", key, bytes);
    },
    remove: async (key) => {
      await native!.storage(bucket, "remove", key);
    },
    loadRange: async (key) =>
      (await native!.storage(bucket, "loadRange", key)) as Awaited<
        ReturnType<StorageAdapterInterface["loadRange"]>
      >,
    removeRange: async (key) => {
      await native!.storage(bucket, "removeRange", key);
    },
  });
  const settings = await repositorySettings();
  const repository = await Repository.open({
    ...relayConnection(settings),
    endpoints: settings.broadcast ? settings.endpoints : [],
    ...options,
    documents: native
      ? adapter("documents")
      : new IndexedDBStorageAdapter(name + "-documents"),
    identity: native
      ? adapter("identity")
      : new IndexedDBStorageAdapter(name + "-identity"),
  });
  if (native && settings.broadcast) {
    const port = new Promise<MessagePort>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(Error("Native repository connection timed out"));
      }, 10000);
      const receive = (event: MessageEvent) => {
        if (
          event.source === window &&
          event.data?.jocki === "repository-port" &&
          event.ports[0]
        ) {
          clearTimeout(timeout);
          window.removeEventListener("message", receive);
          resolve(event.ports[0]);
        }
      };
      window.addEventListener("message", receive);
    });
    await native.connect();
    const channel = repository.hive.createKeyhiveNetworkAdapter(
      new MessageChannelNetworkAdapter(await port),
      { periodicallyRequestSync: true },
    );
    channel.on("ingest-remote", () => repository.repo.shareConfigChanged());
    repository.repo.networkSubsystem.addNetworkAdapter(channel);
  }
  if (settings.broadcast && typeof BroadcastChannel !== "undefined") {
    const channel = repository.hive.createKeyhiveNetworkAdapter(
      new BroadcastChannelNetworkAdapter({ channelName: name }),
      { periodicallyRequestSync: true },
    );
    channel.on("ingest-remote", () => repository.repo.shareConfigChanged());
    repository.repo.networkSubsystem.addNetworkAdapter(channel);
  }
  return repository;
}
