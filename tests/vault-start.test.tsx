// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { notify } from "../packages/ui/notifications";
vi.mock("../packages/ui/notifications", () => ({ notify: { error: vi.fn() } }));
import { createRoot, type Root } from "react-dom/client";
import { VaultEntry } from "../packages/app-ui/vault-entry";
import type {
  VaultLauncher,
  VaultRuntime,
} from "../packages/platform-browser/vault-runtime";
vi.mock("../packages/app-ui/vault-app", async () => {
  const { useEffect } = await import("react");
  return {
    default: ({
      runtime,
      onHome,
    }: {
      runtime: VaultRuntime;
      onHome(): void;
    }) => {
      useEffect(() => {
        runtime.confirmClose = () => Promise.resolve(true);
        return () => {
          runtime.confirmClose = undefined;
        };
      }, [runtime]);
      return (
        <>
          <input aria-label="Document draft" defaultValue="Saved text" />
          <button onClick={onHome}>Close workspace</button>
        </>
      );
    },
  };
});
// A native select is sufficient for testing the entry controller without portals.
vi.mock("../packages/ui/choice-select", () => ({
  ChoiceSelect: ({ value, onValueChange, options, ...props }: any) => (
    <select
      {...props}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="">Choose a workspace</option>
      {options.map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
async function show(launcher: unknown) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(<VaultEntry launcher={launcher as VaultLauncher} />),
  );
}
const draft = () => document.querySelector('[aria-label="Document draft"]');
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent === name,
  )!;
const click = (name: string) => act(async () => button(name).click());
async function choose() {
  if (button("Manage")) await click("Manage");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Saved workspaces"]')!
      .click(),
  );
  await click("Writing");
  await click("Open workspace");
}
function setup() {
  const listeners = new Set<() => void>();
  const runtime = {
    openError: "",
    workspace: { current: { id: "workspace" } },
    confirmClose: undefined as (() => Promise<boolean>) | undefined,
    subscribeOpenErrors(listener: () => void) {
      listeners.add(listener);
    },
    shutdown: vi.fn(async () => {
      expect(draft()).toBeNull();
      listeners.clear();
    }),
    fail(message: string) {
      runtime.openError = message;
      listeners.forEach((listener) => listener());
    },
  };
  const launcher = {
    capabilities: { workspaceFolder: false, vaultFolder: false },
    references: vi.fn(async () => []),
    list: () => [{ id: "workspace", name: "Writing", kind: "internal" }],
    refresh: vi.fn(async () => {}),
    open: vi.fn(async () => runtime),
    create: vi.fn(async () => runtime),
  };
  return { runtime, launcher };
}
it("starts without a workspace and browsing the start pages opens nothing", async () => {
  const { launcher } = setup();
  await show(launcher);
  expect(draft()).toBeNull();
  expect(button("Continue current workspace")).toBeUndefined();
  for (const page of ["Create", "Join", "Manage"]) {
    await click(page);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click(),
    );
  }
  expect(launcher.open).not.toHaveBeenCalled();
  expect(launcher.create).not.toHaveBeenCalled();
});
it("unmounts the workspace and finishes closing it before returning to start", async () => {
  const { runtime, launcher } = setup();
  await show(launcher);
  await choose();
  expect(draft()).toBeTruthy();
  await click("Close workspace");
  expect(runtime.shutdown).toHaveBeenCalledOnce();
  expect(draft()).toBeNull();
  expect(document.querySelector("[data-start-screen]")).toBeTruthy();
  await choose();
  expect(launcher.open).toHaveBeenCalledTimes(2);
});
it("allows cancelling a close and fully unloads after a vault-open error is accepted", async () => {
  const { runtime, launcher } = setup();
  await show(launcher);
  await choose();
  runtime.confirmClose = vi.fn(async () => false);
  await click("Close workspace");
  expect(runtime.shutdown).not.toHaveBeenCalled();
  expect(draft()).toBeTruthy();
  runtime.confirmClose = vi.fn(async () => true);
  await act(async () => runtime.fail("Folder unavailable"));
  expect(runtime.shutdown).toHaveBeenCalledOnce();
  expect(draft()).toBeNull();
  expect(notify.error).toHaveBeenCalledWith("Folder unavailable");
});
it("keeps failed explicit opens on the start screen and retries with a fresh runtime", async () => {
  const { launcher } = setup();
  launcher.open.mockRejectedValueOnce(Error("Folder unavailable"));
  await show(launcher);
  await choose();
  expect(draft()).toBeNull();
  expect(button("Create")).toBeTruthy();
  expect(button("Join")).toBeTruthy();
  expect(button("Manage")).toBeTruthy();
  expect(button("Try again")).toBeUndefined();
  expect(notify.error).toHaveBeenCalledWith("Folder unavailable");
  await choose();
  expect(draft()).toBeTruthy();
});

it("leaves the home actions available when the saved list cannot be refreshed", async () => {
  const { launcher } = setup();
  launcher.refresh.mockRejectedValueOnce(
    Error("Saved workspace list unavailable"),
  );
  await show(launcher);
  await click("Manage");
  expect(button("Create")).toBeTruthy();
  expect(button("Join")).toBeTruthy();
  expect(button("Manage")).toBeTruthy();
  expect(notify.error).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Saved workspace list unavailable" }),
  );
  expect(launcher.open).not.toHaveBeenCalled();
  await choose();
  expect(draft()).toBeTruthy();
});
