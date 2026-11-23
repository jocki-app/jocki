// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Diagnostics,
  ApplicationBoundary,
  diagnosticStorageKey,
} from "../packages/app-ui/diagnostics";
import { reportSyncError, reportTransportError } from "../packages/sync/errors";
import { notify } from "../packages/ui/notifications";
vi.mock("../packages/ui/notifications", () => ({
  notify: { error: vi.fn(), success: vi.fn() },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

it("records pending and retry states without error toasts while still alerting on real failures", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Diagnostics />));
  const before = vi.mocked(notify.error).mock.calls.length;
  await act(async () => {
    reportSyncError(
      { kind: "COPY_PENDING", message: "Downloading" },
      { phase: "owner-request" },
    );
    reportTransportError({ type: "error" }, { phase: "connect" });
  });
  expect(vi.mocked(notify.error).mock.calls.length).toBe(before);
  expect(host.textContent).toContain("Downloading");
  await act(async () => {
    reportSyncError(
      { kind: "INTEGRITY_FAILED", message: "Invalid signature" },
      { phase: "verify" },
    );
  });
  expect(vi.mocked(notify.error).mock.calls.length).toBe(before + 1);
});

it("shows console-only failures in the GUI and saves redacted, copyable details locally", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Diagnostics />));
  await act(async () => {
    reportSyncError(
      { message: "Cannot read workspace token=private", code: "READ_FAILED" },
      { phase: "workspace-open", operation: "Loading workspace data" },
    );
  });
  expect(host.textContent).toContain("workspace-open [READ_FAILED]");
  const copy = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy diagnostics",
  )!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0][0]).not.toContain("token=private");
  expect(writeText.mock.calls[0][0]).toContain("token=[redacted]");
  const saved = JSON.parse(localStorage.getItem(diagnosticStorageKey)!);
  expect(saved.at(-1).context.operation).toBe("Loading workspace data");
  await act(async () => root!.unmount());
  root = createRoot(host);
  await act(async () => root!.render(<Diagnostics />));
  expect(host.textContent).toContain("Recent errors");
});

it("keeps rendering failures visible instead of leaving a blank app", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw Error("Failed workspace projection");
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ApplicationBoundary>
        <Broken />
      </ApplicationBoundary>,
    ),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Failed workspace projection",
  );
  expect(host.textContent).toContain("Back to workspaces");
});

it("shows a useful error when clipboard access is unavailable", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Diagnostics />));
  const copy = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy diagnostics",
  )!;
  await act(async () => copy.click());
  expect(notify.error).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("Clipboard access is unavailable"),
    }),
  );
});
