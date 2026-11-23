import { expect, it } from "vitest";
import { DeviceCore } from "./fixtures/device";
import { MemoryStorage } from "../packages/storage";
it("serializes concurrent creation of the same device record before approving another device", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Mac");
  const phone = await DeviceCore.open(new MemoryStorage(), "Phone");
  try {
    const node = await core.createWorkspace("Workspace"),
      id = crypto.randomUUID();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        node.records.put(
          "devices",
          { name: "Mac " + i, platform: "desktop", capabilities: [] },
          id,
        ),
      ),
    );
    await core.approve(node.link.id, phone.pairingRequest());
    expect(node.replica.status().ready).toBe(true);
    expect(node.replica.error).toBe("");
  } finally {
    await core.close();
    await phone.close();
  }
});
