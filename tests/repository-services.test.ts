import { expect, it, vi } from "vitest";
import { DeviceCore } from "./fixtures/device";
import { MemoryStorage } from "../packages/storage";
import { documentsService } from "../packages/core/documents-service";
import {
  exportWorkspace,
  importWorkspace,
} from "../packages/core/workspace-package";
import { readDeviceRequest } from "../packages/core/pairing";

it("gives plugins native handles and merges concurrent fields", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A");
  const b = await DeviceCore.open(new MemoryStorage(), "B");
  const source = await a.createWorkspace("Plugins");
  const first = documentsService(source, "example");
  const left = await first.open<{ title: string; done: boolean }>(
    source.replica.graph.defaultSchemaId,
    "task",
    "example",
    { title: "Initial", done: false },
  );
  left.change((doc) => {
    doc.title = "Initial";
    doc.done = false;
  });
  await first.flush();
  const target = await b.join(
    await a.approve(source.link.id, b.pairingRequest()),
  );
  await expect
    .poll(
      () => target.replica.heads("").join() === source.replica.heads("").join(),
      { timeout: 12000 },
    )
    .toBe(true);
  const second = documentsService(target, "example");
  const right = await second.open<{ title: string; done: boolean }>(
    source.replica.graph.defaultSchemaId,
    "task",
    "example",
  );
  left.change((doc) => {
    doc.title = "Updated";
  });
  right.change((doc) => {
    doc.done = true;
  });
  await Promise.all([first.flush(), second.flush()]);
  await expect
    .poll(() => left.doc(), { timeout: 12000 })
    .toEqual({ title: "Updated", done: true });
  await expect
    .poll(() => right.doc(), { timeout: 12000 })
    .toEqual({ title: "Updated", done: true });
});

it("denies read-only writes and executes explicit commands once, never replicated data", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A");
  const b = await DeviceCore.open(new MemoryStorage(), "B");
  const source = await a.createWorkspace("Commands");
  const state = await documentsService(source, "example").open<{
    value: number;
  }>(source.replica.graph.defaultSchemaId, "task", "example", { value: 0 });
  state.change((doc) => {
    doc.value = 1;
  });
  await source.replica.flush();
  const target = await b.join(
    await a.approve(source.link.id, b.pairingRequest({ access: "read" })),
  );
  const view = await documentsService(target, "example").open<{
    value: number;
  }>(source.replica.graph.defaultSchemaId, "task", "example");
  expect(() =>
    view.change((doc) => {
      doc.value = 2;
    }),
  ).toThrow();
  const execute = vi.fn(async () => "accepted");
  source.protocol.setHandler(execute);
  target.protocol.setHandler(execute);
  await expect(
    target.replica.update("setting/test", { value: 1 }),
  ).rejects.toThrow("read only");
  await expect(target.protocol.localCall("terminal.open", {})).rejects.toThrow(
    "Read-only",
  );
  await expect(
    target.protocol.call("terminal.open", {}, a.identity.id, "reader-command"),
  ).rejects.toThrow("Read-only");
  await source.replica.update("job/remote-command", {
    command: "terminal.open",
    input: { command: "example" },
  });
  await expect
    .poll(() => target.replica.read("job/remote-command"), { timeout: 12000 })
    .toBeDefined();
  expect(execute).not.toHaveBeenCalled();
  expect(
    await source.protocol.localCall(
      "example.run",
      { value: 1 },
      "same-request",
    ),
  ).toBe("accepted");
  expect(
    await source.protocol.localCall(
      "example.run",
      { value: 1 },
      "same-request",
    ),
  ).toBe("accepted");
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(
    source.protocol.localCall("example.run", { value: 2 }, "same-request"),
  ).rejects.toThrow("reused");
});

it("exports standard bundles with files and imports a new identity without secret access", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A");
  const source = await a.createWorkspace("Portable");
  const title = await source.records.put("credentials", {
    name: "Example",
    provider: "example",
    auth_kind: "api-key",
    allowed_plugins: [],
    allowed_destinations: [],
  });
  await source.vault.set(title.id, { token: "private-value" });
  const file = await source.protocol.files.save(
    crypto.randomUUID(),
    new TextEncoder().encode("file contents"),
    "text/plain",
    null,
  );
  const bytes = await exportWorkspace(source);
  const b = await DeviceCore.open(new MemoryStorage(), "B");
  const imported = await importWorkspace(b, bytes);
  expect(imported.link.id).not.toBe(source.link.id);
  expect(imported.replica.member.identity.id).toBe(b.identity.id);
  expect(imported.replica.ids("vault/")).toEqual([]);
  expect(imported.records.get(title.id)?.data.status).toBe(
    "needs-authorization",
  );
  expect(
    new TextDecoder().decode(
      (await imported.protocol.files.read(file.id)).bytes,
    ),
  ).toBe("file contents");
});

it("binds approval to the Keyhive contact identity and workspace", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A");
  const b = await DeviceCore.open(new MemoryStorage(), "B");
  const source = await a.createWorkspace("Contacts");
  const request = JSON.parse(b.pairingRequest());
  request.identity.id = a.identity.id;
  expect(() => readDeviceRequest(JSON.stringify(request))).toThrow("identity");
  await expect(
    a.approve(
      source.link.id,
      b.pairingRequest({ workspaceId: crypto.randomUUID() }),
    ),
  ).rejects.toThrow("different workspace");
});
