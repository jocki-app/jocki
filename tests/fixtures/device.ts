import { MessageChannel } from "node:worker_threads";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { afterEach } from "vitest";
import { DeviceCore as Core } from "../../packages/core/device";
import { testRepository } from "./repository";
export {
  WorkspaceNode,
  type LinkedWorkspace,
} from "../../packages/core/device";
export type DeviceCore = Core;
const opened = new Set<Core>();
afterEach(async () => {
  const cores = [...opened];
  opened.clear();
  const results = await Promise.allSettled(cores.map((core) => core.close()));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(failures.map((result) => result.reason));
});
export const DeviceCore = {
  async open(...args: Parameters<typeof Core.open>) {
    const core = await Core.open(
      args[0],
      args[1],
      args[2],
      args[3] ?? (await testRepository(args[0])),
      args[4],
    );
    // Restart tests must not attach new adapters to an already closed peer.
    const close = core.close.bind(core);
    core.close = () => {
      opened.delete(core);
      return close();
    };
    for (const other of opened) {
      const { port1, port2 } = new MessageChannel();
      const left = core.repository.hive.createKeyhiveNetworkAdapter(
        new MessageChannelNetworkAdapter(port1 as unknown as MessagePort),
        { periodicallyRequestSync: true, syncRequestInterval: 100 },
      );
      const right = other.repository.hive.createKeyhiveNetworkAdapter(
        new MessageChannelNetworkAdapter(port2 as unknown as MessagePort),
        { periodicallyRequestSync: true, syncRequestInterval: 100 },
      );
      left.on("ingest-remote", () => core.repository.repo.shareConfigChanged());
      right.on("ingest-remote", () =>
        other.repository.repo.shareConfigChanged(),
      );
      core.repository.repo.networkSubsystem.addNetworkAdapter(left);
      other.repository.repo.networkSubsystem.addNetworkAdapter(right);
    }
    opened.add(core);
    return core;
  },
};
