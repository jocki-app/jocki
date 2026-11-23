// @vitest-environment jsdom
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  notify,
  useNotificationState,
  connectLogNotifications,
} from "../packages/ui/notifications";
import { LocalLogStore, logError, logger } from "../packages/core/local-logs";
import { z } from "zod";
let disconnect: () => void;
let logs: LocalLogStore;
beforeEach(async () => {
  const files = new Map<string, Uint8Array>();
  logs = await LocalLogStore.open({
    read: async (path) => files.get(path),
    writeAtomic: async (path, bytes) => {
      files.set(path, bytes);
    },
    remove: async (path) => {
      files.delete(path);
    },
    list: async () => [...files.keys()],
  });
  logs.configure();
  disconnect = connectLogNotifications();
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  disconnect();
  await logs.flush();
  logs.unconfigure();
  vi.clearAllMocks();
  vi.useRealTimers();
});
it("deduplicates a repeated background failure until it stops recurring", () => {
  vi.useFakeTimers();
  notify.error(new Error("Peer is unavailable"));
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(3000);
    notify.error("Peer is unavailable");
  }
  expect(toast.error).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5001);
  notify.error("Peer is unavailable");
  expect(toast.error).toHaveBeenCalledTimes(2);
});
it("keeps success, warning and information distinct and ignores empty feedback", () => {
  notify.success("Saved");
  notify.warning("Offline");
  notify.info("Queued");
  notify.error("");
  expect(toast.success).toHaveBeenCalledWith(
    "Saved",
    expect.objectContaining({ duration: 4000 }),
  );
  expect(toast.warning).toHaveBeenCalledWith("Offline", expect.anything());
  expect(toast.info).toHaveBeenCalledWith("Queued", expect.anything());
  expect(toast.error).not.toHaveBeenCalled();
});
it("reports errors once under StrictMode and can report an action after navigation", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
  let update!: (value: string) => void;
  function Screen() {
    const [error, setError] = useNotificationState(
      "error",
      "Cannot open workspace",
    );
    update = setError;
    return <span>{error}</span>;
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <Screen />
      </StrictMode>,
    ),
  );
  expect(toast.error).toHaveBeenCalledTimes(1);
  await act(async () => update(""));
  expect(container.textContent).toBe("");
  expect(toast.error).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  update("File write failed");
  expect(toast.error).toHaveBeenLastCalledWith(
    "File write failed",
    expect.objectContaining({ duration: 8000 }),
  );
});

it("deduplicates a core error reported as both an Error and a string", () => {
  const error = new Error("Parent cycle rejected");
  error.name = "CoreError";
  notify.error(error);
  notify.error(String(error));
  expect(toast.error).toHaveBeenCalledTimes(1);
});

it("summarizes multiline validation errors instead of showing an opening bracket", async () => {
  const result = z
    .object({
      entries: z.array(z.object({ kind: z.enum(["internal", "folder"]) })),
    })
    .safeParse({ entries: [{}] });
  expect(result.success).toBe(false);
  if (result.success) return;
  // Zod's browser stack can be only its name, without a colon or message.
  result.error.stack = "ZodError";
  notify.error(result.error);
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringMatching(/^Validation failed: entries\.0\.kind: .+/),
    expect.anything(),
  );
  await logs.flush();
  const [record] = await logs.list();
  expect(record.message).toContain('"code": "invalid_value"');
  expect(record.message).toContain("ZodError");
});

it("keeps contextual errors readable and handles truncated structured diagnostics", () => {
  logError(
    new Error(
      'Could not read saved workspaces.\n[\n  {"message": "Invalid value"}\n]',
    ),
    "startup",
  );
  expect(toast.error).toHaveBeenLastCalledWith(
    "Could not read saved workspaces.",
    expect.anything(),
  );
  logger("validation").error("[\n  {truncated diagnostic");
  expect(toast.error).toHaveBeenLastCalledWith(
    "Validation failed. Open Local logs for details.",
    expect.anything(),
  );
});

it("presents logger errors and warnings centrally and retains redacted details without a notification loop", async () => {
  const action = vi.fn();
  disconnect();
  disconnect = connectLogNotifications(action);
  logError(
    new Error("Storage failure token=private-value saddle://share/abc123"),
    "storage",
  );
  logger("sync").warn("Connection interrupted");
  logger("sync").info("Routine progress");
  await logs.flush();
  const rows = await logs.list();
  expect(rows).toHaveLength(3);
  expect(toast.error).toHaveBeenCalledOnce();
  expect(toast.warning).toHaveBeenCalledOnce();
  expect(toast.info).not.toHaveBeenCalled();
  expect(rows[0].message + rows[1].message + rows[2].message).not.toContain(
    "private-value",
  );
  expect(JSON.stringify(rows)).not.toContain("share/abc123");
  const options = vi.mocked(toast.error).mock.calls[0][1] as any;
  options.action.onClick();
  expect(action).toHaveBeenCalledOnce();
  expect(await logs.list()).toHaveLength(3);
});
