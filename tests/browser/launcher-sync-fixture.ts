import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import type {
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo";
import { Repository } from "../../packages/core/repository";
import { FileVault } from "../../packages/core/vaults/vault";
import { WorkspaceStore } from "../../packages/core/vaults/workspace";
import {
  ProtectedFileSync,
  type ShareKind,
} from "../../packages/core/vaults/protected-sync";
import { shareLink } from "../../packages/core/vaults/share-invitation";
import { openBrowserRepository } from "../../packages/platform-browser/repository";
import { saveRepositorySettings } from "../../packages/platform-browser/repository-settings";
import { defaultRepositorySettings } from "../../packages/core/relay-settings";
import { utf8 } from "../../packages/core/crypto";
class Files {
  values = new Map<string, Uint8Array>();
  async read(path: string) {
    return this.values.get(path)?.slice();
  }
  async writeAtomic(path: string, bytes: Uint8Array) {
    this.values.set(path, bytes.slice());
  }
  async remove(path: string) {
    this.values.delete(path);
  }
  async list() {
    return [...this.values.keys()].filter(
      (path) => !path.startsWith(".saddle/"),
    );
  }
}
class Storage implements StorageAdapterInterface {
  values = new Map<string, Uint8Array>();
  async load(key: StorageKey) {
    return this.values.get(JSON.stringify(key))?.slice();
  }
  async save(key: StorageKey, bytes: Uint8Array) {
    this.values.set(JSON.stringify(key), bytes.slice());
  }
  async remove(key: StorageKey) {
    this.values.delete(JSON.stringify(key));
  }
  async loadRange(prefix: StorageKey) {
    return [...this.values].flatMap(([serialized, data]) => {
      const key = JSON.parse(serialized);
      return prefix.every((part, i) => key[i] === part)
        ? [{ key, data: data.slice() }]
        : [];
    });
  }
  async removeRange(prefix: StorageKey) {
    for (const { key } of await this.loadRange(prefix)) await this.remove(key);
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    for (const [key, value] of entries) await this.save(key, value);
  }
}
export async function setup(kind: ShareKind) {
  // Only local BroadcastChannel transport. The unavailable relay is never used
  // for test data; it keeps the user-facing relay configuration well-formed.
  await saveRepositorySettings({
    ...defaultRepositorySettings(),
    broadcast: true,
    selected: "test",
    endpoints: ["ws://127.0.0.1:1"],
    saved: [
      {
        id: "test",
        name: "Local test",
        endpoints: ["ws://127.0.0.1:1"],
        syncServer: "keyhive",
      },
    ],
  });
  const recipient = await openBrowserRepository("jocki-file-repo", {
    endpoints: [],
  });
  const source = await Repository.open({
    documents: new Storage(),
    identity: new Storage(),
  });
  const channel = source.hive.createKeyhiveNetworkAdapter(
    new BroadcastChannelNetworkAdapter({ channelName: "jocki-file-repo" }),
    { periodicallyRequestSync: true },
  );
  channel.on("ingest-remote", () => source.repo.shareConfigChanged());
  source.repo.networkSubsystem.addNetworkAdapter(channel);
  const workspace = await WorkspaceStore.open(
    new Files(),
    "owner",
    "Shared workspace",
  );
  const vault = await FileVault.open(new Files(), "owner", {
    name: "Shared vault",
  });
  const file = await vault.create(
    "Folder/note.md",
    utf8.encode("# Shared through launcher"),
  );
  const sync = await ProtectedFileSync.open(
    source,
    new Files(),
    workspace,
    (error) => console.error(error),
  );
  await sync.attach(vault);
  const invitation =
    kind === "workspace"
      ? await sync.createWorkspace([vault])
      : await sync.create(
          vault,
          kind,
          kind === "file"
            ? "Folder/note.md"
            : kind === "folder"
              ? "Folder"
              : "",
        );
  await sync.grant(invitation, recipient.contactCard, "edit");
  // Preload only the signed contract into the recipient cache. Its next normal
  // repository instance must fetch file content through the live local peer.
  await ProtectedFileSync.inspect(recipient, shareLink(invitation));
  await recipient.close();
  (window as any).launcherSyncFixture = {
    stop: async () => {
      await sync.close();
      await source.close();
    },
  };
  return {
    link: shareLink(invitation),
    file,
    vault: vault.id,
    name: invitation.name,
  };
}
