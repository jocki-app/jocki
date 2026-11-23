import { connectLogNotifications } from "../packages/ui/notifications";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { toast } from "sonner";
import { RecordTable } from "../packages/app-ui/record-table";
import { OptimisticRecords } from "../packages/ui/optimistic";
import type { AppRuntime } from "../packages/app-ui/runtime";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { field, type RecordSchema } from "@jocki/platform/field-types";
vi.mock("../packages/core/membership", () => ({
  membership: () => ({ members: {} }),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps other rows editable during a slow save, exposes pending sync, and restores a failed draft", async () => {
  const schema: RecordSchema = {
    id: "variables",
    pluginId: "variables",
    name: "Variables",
    version: 1,
    fields: [
      field("name", "Name"),
      field("labels", "Labels", "text", { array: true, inputMode: "list" }),
    ],
  };
  const rows = ["one", "two"].map((id): ResourceRecord => ({
    id,
    collection: "variables",
    pluginId: "variables",
    workspaceId: "workspace",
    ownerId: "owner",
    revision: 1,
    createdAt: "2026-10-06",
    updatedAt: "2026-10-06",
    deletedAt: null,
    data: { name: id, labels: ["first", "second"] },
  }));
  let reject!: (error: Error) => void;
  const slow = new Promise<void>((_, no) => {
    reject = no;
  });
  const source = {
    list: async () => rows,
    put: async () => {
      await slow;
      return rows[0];
    },
    delete: async () => {},
  };
  const optimistic = new OptimisticRecords({
    workspaceId: "workspace",
    ownerId: "owner",
    saved: (id) => rows.find((row) => row.id === id),
    error: () => {},
    track: (work) => work(),
  });
  const store = optimistic.wrap(schema, source, "test");
  const runtime = {
    optimistic,
    profile: { id: "test", workspaceId: "workspace" },
    principal: { userId: "owner" },
    collection: () => store,
    db: {
      records: { toArray: async () => rows },
      getMetadata: async () => undefined,
      setMetadata: async () => {},
    },
    node: {
      protocol: {
        storage: {
          listeners: new Set(),
          status: async () => ({
            version: { token: "saved-version" },
            copies: [{ deviceId: "local", retained: true }],
          }),
        },
      },
      replica: { access: {}, identity: { id: "local" }, listeners: new Set() },
    },
    synchronize: async () => {},
  } as unknown as AppRuntime;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(
      `[data-record-id="one"] button[aria-label="${label}"]`,
    )!;
  const input = (id: string) =>
    host.querySelector<HTMLInputElement>(
      `[data-record-id="${id}"] input[aria-label="Name"]`,
    )!;
  try {
    await act(async () =>
      root.render(
        <RecordTable
          runtime={runtime}
          collection="variables"
          schemaOverride={schema}
        />,
      ),
    );
    expect(input("one").value).toBe("one");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input("one"), "Edited");
      input("one").dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-record-id="one"] [data-slot="combobox-chip-remove"]',
        )!
        .click(),
    );
    const chips = () =>
      [
        ...host.querySelectorAll(
          '[data-record-id="one"] [data-slot="combobox-chip"]',
        ),
      ].map((el) => el.textContent);
    expect(chips()).toEqual(["second"]);
    await act(async () => button("Save entry").click());
    expect(input("one").value).toBe("Edited");
    expect(button("Saving changes")).not.toBeNull();
    expect(chips()).toEqual(["second"]);
    expect(input("two").disabled).toBe(false);
    expect(rows[0].data.name).toBe("one");
    await act(async () => reject(Error("Save was rejected")));
    expect(optimistic.count("one")).toBe(0);
    expect(chips()).toEqual(["second"]);
    expect(input("one").value).toBe("Edited");
    expect(button("Save entry")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Discard edits").click());
    expect(input("one").value).toBe("one");
    expect(chips()).toEqual(["first", "second"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("checks every descendant's permission before deleting any part of a grouped branch", async () => {
  const errorToast = vi.spyOn(toast, "error");
  const disconnect = connectLogNotifications();
  const schema: RecordSchema = {
    id: "variables",
    pluginId: "variables",
    name: "Variables",
    version: 1,
    fields: [
      field("name", "Name"),
      field("belongs_to", "Belongs to", "text", {
        reference: "variables",
        referenceField: "id",
      }),
    ],
  };
  const rows = [
    {
      id: "parent",
      ownerId: "owner",
      data: { name: "Parent", belongs_to: null },
    },
    {
      id: "child",
      ownerId: "someone-else",
      data: { name: "Child", belongs_to: "parent" },
    },
  ].map((row) => ({
    ...row,
    collection: "variables",
    pluginId: "variables",
    workspaceId: "workspace",
    revision: 1,
    createdAt: "2026-10-06",
    updatedAt: "2026-10-06",
    deletedAt: null,
  })) as ResourceRecord[];
  const source = { list: async () => rows, put: vi.fn(), delete: vi.fn() };
  const optimistic = new OptimisticRecords({
    workspaceId: "workspace",
    ownerId: "owner",
    saved: (id) => rows.find((row) => row.id === id),
    error: () => {},
    track: (work) => work(),
  });
  const runtime = {
    optimistic,
    profile: { id: "test-delete", workspaceId: "workspace" },
    principal: { userId: "owner" },
    collection: () => source,
    db: {
      records: { toArray: async () => rows },
      getMetadata: async () => undefined,
      setMetadata: async () => {},
    },
    node: {
      protocol: {
        storage: {
          listeners: new Set(),
          status: async () => ({ version: { token: "saved" }, copies: [] }),
        },
      },
      replica: { access: {}, identity: { id: "local" }, listeners: new Set() },
    },
    synchronize: async () => {},
  } as unknown as AppRuntime;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <RecordTable
          runtime={runtime}
          collection="variables"
          schemaOverride={schema}
          defaultView={{
            groups: [
              {
                id: "g",
                field: "belongs_to",
                enabled: true,
                mode: "recursive",
                materialize: true,
              },
            ],
          }}
        />,
      ),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-record-id="parent"] button[aria-label="Delete entry"]',
        )!
        .click(),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete 2 entries?");
    expect(dialog.textContent).toContain("1 descendant entry");
    await act(async () =>
      [...dialog.querySelectorAll("button")]
        .find((button) => button.textContent === "Delete")!
        .click(),
    );
    expect(source.delete).not.toHaveBeenCalled();
    expect(errorToast).toHaveBeenCalledWith(
      "An entry or one of its descendants is read-only or still saving.",
      expect.any(Object),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    disconnect();
    errorToast.mockRestore();
  }
});
