import { expect, it, onTestFailed } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { MessagePortTransport } from "@automerge/automerge-subduction";
import type { PeerId } from "@automerge/automerge-repo";
import { Repository } from "../packages/core/repository";
import { MemoryStorage } from "../packages/storage";
import { TestRepoStorage } from "./fixtures/repository";
import { base64 } from "../packages/core/crypto";

it("authenticates peers and synchronizes a Keyhive-protected document over the official Subduction transport", async () => {
  let stage = "identity keys";
  onTestFailed(() => console.error("Transport test stage:", stage));
  const keys = await Promise.all([
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
  ]);
  const ids = await Promise.all(
    keys.map(
      async (key) =>
        base64(
          new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)),
        ) as PeerId,
    ),
  );
  const stores = [new MemoryStorage(), new MemoryStorage()];
  stage = "opening repositories";
  const repos = await Promise.all(
    stores.map((store, index) =>
      Repository.open({
        documents: new TestRepoStorage(store, "documents"),
        identity: new TestRepoStorage(store, "identity"),
        keyPair: keys[index],
        syncServer: "none",
        remotePeerId: ids[1 - index],
      }),
    ),
  );
  const [alice, bob] = repos;
  try {
    const { port1, port2 } = new MessageChannel();
    const subs = await Promise.all(repos.map((repo) => repo.repo.subduction));
    stage = "connecting authenticated transports";
    await Promise.all([
      subs[0].connectTransport(new MessagePortTransport(port1), "jocki"),
      subs[1].acceptTransport(new MessagePortTransport(port2), "jocki"),
    ]);
    for (const repo of repos) repo.hive.networkAdapter.startPeriodicSync();
    stage = "creating private document";
    const privateHandle = await alice.create({ secret: "Unshared" });
    expect(
      await bob.hive.bestAccessForDoc(
        bob.hive.active.individual.id,
        privateHandle.url,
      ),
    ).toBeUndefined();
    stage = "checking denied document access";
    await expect(
      bob.repo.find(privateHandle.url, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    stage = "creating shared document";
    const handle = await alice.create({ title: "Shared", completed: false });
    stage = "granting shared document";
    await alice.grant(handle, bob.contactCard, "edit");
    alice.hive.networkAdapter.syncKeyhive();
    bob.hive.networkAdapter.syncKeyhive();
    stage = "waiting for grant delivery";
    await expect
      .poll(
        async () =>
          (
            await bob.hive.bestAccessForDoc(
              bob.hive.active.individual.id,
              handle.url,
            )
          )?.isEditor,
        { timeout: 12000 },
      )
      .toBe(true);
    stage = "loading shared document";
    const remote = await bob.repo.find<{ title: string; completed: boolean }>(
      handle.url,
      { signal: AbortSignal.timeout(12000) },
    );
    expect(remote.doc()?.title).toBe("Shared");
    remote.change((doc) => {
      doc.completed = true;
    });
    stage = "saving remote edit";
    await bob.flush();
    stage = "waiting for remote edit";
    await expect
      .poll(() => handle.doc()?.completed, { timeout: 12000 })
      .toBe(true);
  } finally {
    stage = "closing repositories";
    await Promise.all(repos.map((repo) => repo.close()));
  }
}, 40000);
