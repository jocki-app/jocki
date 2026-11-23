/** Opt-in integration check. Sends synthetic test documents through the public relay. */
import assert from "node:assert/strict";
import { Repository } from "../packages/core/repository";
import { DeviceCore } from "../packages/core/device";
import {
  defaultRepositorySettings,
  relayConnection,
} from "../packages/core/relay-settings";
import { MemoryStorage } from "../packages/storage";
import { TestRepoStorage } from "./fixtures/repository";
const stores = [new MemoryStorage(), new MemoryStorage()];
const repos = await Promise.all(
  stores.map((store) =>
    Repository.open({
      documents: new TestRepoStorage(store, "documents"),
      identity: new TestRepoStorage(store, "identity"),
      ...relayConnection(defaultRepositorySettings()),
    }),
  ),
);
const cores = await Promise.all(
  repos.map((repo, i) =>
    DeviceCore.open(stores[i], "Relay test " + i, () => [], repo, {
      commandHost: false,
    }),
  ),
);
async function until(predicate: () => boolean, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert(predicate(), "Relay operation did not finish before timeout");
}
try {
  await until(() => repos.every((repo) => repo.repo.isSubductionConnected()));
  const source = await cores[0].createWorkspace("Isolated relay verification");
  const row = await source.records.put("variables", {
    name: "Relay verification value",
  });
  const target = await cores[1].join(
    await cores[0].approve(source.link.id, cores[1].pairingRequest()),
  );
  assert.equal(
    target.records.get(row.id)?.data.name,
    "Relay verification value",
  );
  await target.records.put(
    "variables",
    { ...target.records.get(row.id)!.data, name: "Verified peer edit" },
    row.id,
  );
  await until(
    () => source.records.get(row.id)?.data.name === "Verified peer edit",
  );
  console.log(
    "Public Automerge relay: invitation access delivery and encrypted two-way document sync passed.",
  );
} finally {
  await Promise.all(cores.map((core) => core.close()));
}
