import { expect, it } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage } from "../packages/storage";
import { testRepository } from "./fixtures/repository";
import { documentsService } from "../packages/core/documents-service";
function connect(a: DeviceCore, b: DeviceCore) {
  const { port1, port2 } = new MessageChannel();
  const left = a.repository.hive.createKeyhiveNetworkAdapter(
    new MessageChannelNetworkAdapter(port1 as unknown as MessagePort),
    { periodicallyRequestSync: true, syncRequestInterval: 100 },
  );
  const right = b.repository.hive.createKeyhiveNetworkAdapter(
    new MessageChannelNetworkAdapter(port2 as unknown as MessagePort),
    { periodicallyRequestSync: true, syncRequestInterval: 100 },
  );
  left.on("ingest-remote", () => a.repository.repo.shareConfigChanged());
  right.on("ingest-remote", () => b.repository.repo.shareConfigChanged());
  a.repository.repo.networkSubsystem.addNetworkAdapter(left);
  b.repository.repo.networkSubsystem.addNetworkAdapter(right);
  return () => {
    left.disconnect();
    right.disconnect();
    port1.close();
    port2.close();
  };
}
it("retains both peers' items when a plugin/schema index is created concurrently", async () => {
  const stores = [new MemoryStorage(), new MemoryStorage()];
  const cores = await Promise.all(
    stores.map(async (store, index) =>
      DeviceCore.open(
        store,
        index ? "B" : "A",
        () => [],
        await testRepository(store),
      ),
    ),
  );
  let disconnect = () => {};
  try {
    const [a, b] = cores,
      source = await a.createWorkspace("Concurrent indexes");
    const invitation = await a.approve(source.link.id, b.pairingRequest());
    disconnect = connect(a, b);
    const target = await b.join(invitation),
      schema = source.replica.graph.defaultSchemaId;
    await expect
      .poll(
        () =>
          source.replica.heads("").join() === target.replica.heads("").join(),
        { timeout: 12000 },
      )
      .toBe(true);
    disconnect();
    const first = documentsService(source, "example"),
      second = documentsService(target, "example");
    await Promise.all([
      first.open(schema, "task", "left", { title: "Left" }),
      second.open(schema, "task", "right", { title: "Right" }),
    ]);
    disconnect = connect(a, b);
    await expect
      .poll(
        async () => (await first.list(schema)).map((item) => item.id).sort(),
        { timeout: 12000 },
      )
      .toEqual(["left", "right"]);
    await expect
      .poll(
        async () => (await second.list(schema)).map((item) => item.id).sort(),
        { timeout: 12000 },
      )
      .toEqual(["left", "right"]);
    expect(Object.keys((await first.index(schema)).doc()!.items)).toHaveLength(
      2,
    );
    expect(Object.keys((await second.index(schema)).doc()!.items)).toHaveLength(
      2,
    );
  } finally {
    disconnect();
    await Promise.all(cores.map((core) => core.close()));
  }
}, 40000);
