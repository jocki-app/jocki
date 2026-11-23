// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TrackingView, elapsedSeconds } from "../packages/app-ui/tracking-view";
import type { AppRuntime } from "../packages/app-ui/runtime";
import { selectedCollectionTable } from "../packages/app-ui/collection-tables";
import { notify } from "../packages/ui/notifications";
import { RecordTable } from "../packages/app-ui/record-table";

vi.mock("../packages/app-ui/record-table", () => ({
  RecordTable: vi.fn(() => <div>Records</div>),
}));
vi.mock("../packages/app-ui/collection-tables", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../packages/app-ui/collection-tables")
  >()),
  selectedCollectionTable: vi.fn(async () => ({
    id: "table",
    data: { is_default: true },
  })),
}));
vi.mock("../packages/ui/notifications", () => ({ notify: { error: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function render(
  collection: "track" | "time",
  rows: any[] = [],
  writable = true,
) {
  const put = vi.fn(async (data, id) => ({ id: id ?? "new", data }));
  const setMetadata = vi.fn(async () => {});
  const runtime = {
    timers: {
      forPlugin: () => ({
        submit: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      }),
    },
    collection: () => ({ list: async () => rows, put, delete: vi.fn() }),
    db: { getMetadata: async () => undefined, setMetadata },
    node: { records: { canWrite: () => writable } },
    registry: { enabled: () => true },
    navigate: vi.fn(),
  } as unknown as AppRuntime;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<TrackingView runtime={runtime} collection={collection} />);
  });
  return { put, setMetadata, runtime };
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label,
  )!;
it("restores Session and Entries controls and opens manual entry without writing", async () => {
  const { put } = await render("track");
  expect(host.textContent).toContain("Session Fields");
  expect(button("Start At")).toBeTruthy();
  expect(button("Continue")).toBeUndefined();
  expect(
    [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent),
  ).toEqual([]);
  await act(async () => button("Manual").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Manual Entry",
  );
  expect(
    document.querySelectorAll('input[type="datetime-local"]'),
  ).toHaveLength(2);
  expect(put).not.toHaveBeenCalled();
});
it("omits page-specific field configuration and filters", async () => {
  await render("track");
  expect(button("Choose fields")).toBeUndefined();
  expect(button("Configure fields")).toBeUndefined();
  expect(host.textContent).not.toContain(
    "Choose fields to add session metadata",
  );
  expect(host.textContent).not.toContain("Filter value");
});
it("updates the running clock without rebuilding historical table rows", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  await render("track", [
    {
      id: "running",
      data: {
        started_at: new Date(Date.now() - 120000).toISOString(),
        ended_at: null,
      },
    },
  ]);
  const count = vi.mocked(RecordTable).mock.calls.length;
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(host.querySelector('[role="timer"]')?.textContent).toBe("00:02:03");
  expect(vi.mocked(RecordTable).mock.calls.length).toBe(count);
});
it("shows Focus and Break duration controls and respects read-only access", async () => {
  const { put } = await render("time", [], false);
  expect(button("15")).toBeTruthy();
  expect(button("Break")).toBeTruthy();
  expect(button("Start").disabled).toBe(true);
  expect(host.querySelector('[role="timer"]')?.textContent).toBe("00:15:00");
  expect(put).not.toHaveBeenCalled();
});
it("does not stop a received expired timer or execute writes upon replication", async () => {
  const { put } = await render("time", [
    {
      id: "remote",
      data: {
        started_at: new Date(Date.now() - 60000).toISOString(),
        target_seconds: 1,
        title: "Remote timer",
        ended_at: null,
      },
    },
  ]);
  expect(button("Stop Session")).toBeTruthy();
  expect(put).not.toHaveBeenCalled();
});
it("counts paused duration and resumes with accumulated pauses excluded", () => {
  const data = {
    started_at: "2026-10-19T00:00:00Z",
    paused_at: "2026-10-19T00:02:00Z",
    paused_ms: "30000",
  };
  expect(elapsedSeconds(data, Date.parse("2026-10-19T01:00:00Z"))).toBe(90);
  expect(
    elapsedSeconds(
      { ...data, paused_at: null, paused_ms: "90000" },
      Date.parse("2026-10-19T00:04:00Z"),
    ),
  ).toBe(150);
});
it("reports a failed start and keeps the session form available", async () => {
  const { put } = await render("track");
  put.mockRejectedValueOnce(new Error("Disk full"));
  await act(async () => button("Start").click());
  expect(notify.error).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Disk full" }),
  );
  expect(button("Start").disabled).toBe(false);
});

it("waits for the selected schema before allowing session draft edits", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise<any>((yes) => {
    resolve = yes;
  });
  vi.mocked(selectedCollectionTable).mockReturnValueOnce(pending);
  await render("track");
  expect(
    host.querySelector('[role="status"]')?.getAttribute("aria-label"),
  ).toBe("Opening table…");
  expect(button("Start")).toBeUndefined();
  await act(async () => {
    resolve({ id: "table", data: {} });
    await pending;
  });
  expect(button("Start")).toBeTruthy();
});
