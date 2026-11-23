import { expect, it } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { MessagePortTransport } from "@automerge/automerge-subduction";
import type { PeerId } from "@automerge/automerge-repo";
import { Repository } from "../packages/core/repository";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage } from "../packages/storage";
import { TestRepoStorage } from "./fixtures/repository";
import { base64 } from "../packages/core/crypto";
it("syncs a workspace graph and editor-created children over encrypted Subduction", async () => {
  const keys = await Promise.all([
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
  ]);
  const peers = await Promise.all(
    keys.map(
      async (key) =>
        base64(
          new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)),
        ) as PeerId,
    ),
  );
  const stores = [new MemoryStorage(), new MemoryStorage()];
  const repos = await Promise.all(
    stores.map((store, index) =>
      Repository.open({
        documents: new TestRepoStorage(store, "docs"),
        identity: new TestRepoStorage(store, "identity"),
        keyPair: keys[index],
        syncServer: "none",
        remotePeerId: peers[1 - index],
      }),
    ),
  );
  const cores = await Promise.all(
    repos.map((repo, index) =>
      DeviceCore.open(stores[index], index ? "B" : "A", () => [], repo),
    ),
  );
  try {
    const { port1, port2 } = new MessageChannel(),
      subs = await Promise.all(repos.map((repo) => repo.repo.subduction));
    await Promise.all([
      subs[0].connectTransport(new MessagePortTransport(port1), "graph"),
      subs[1].acceptTransport(new MessagePortTransport(port2), "graph"),
    ]);
    repos.forEach((repo) => repo.hive.networkAdapter.startPeriodicSync());
    const [a, b] = cores,
      source = await a.createWorkspace("Encrypted hierarchy");
    const first = await source.records.put("variables", { name: "From A" });
    const target = await b.join(
      await a.approve(source.link.id, b.pairingRequest()),
    );
    expect(target.records.get(first.id)?.data.name).toBe("From A");
    const next = await target.records.put("variables", { name: "From B" });
    await expect
      .poll(() => source.records.get(next.id)?.data.name, { timeout: 15000 })
      .toBe("From B");
    expect(
      await repos[0].hive.bestAccessForDoc(
        repos[0].hive.active.individual.id,
        target.replica.computerSettings.handle.url,
      ),
    ).toBeUndefined();
    expect(
      source.replica.graph.item("record/" + first.id)?.documentId,
    ).not.toBe(source.replica.graph.item("record/" + next.id)?.documentId);
  } finally {
    await Promise.all(cores.map((core) => core.close()));
  }
}, 45000);
