// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveStatusButton } from "../packages/ui/save-status-button";
import { notify } from "../packages/ui/notifications";

vi.mock("../packages/ui/notifications", () => ({ notify: { error: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
async function show(node: ReactNode) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(node));
}

it("reports saving until durable completion, then shows the saved storage icon", async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const onSave = vi.fn(() => pending);
  await show(<SaveStatusButton dirty onSave={onSave} />);
  const button = document.querySelector("button")!;
  await act(async () => button.click());
  expect(onSave).toHaveBeenCalledOnce();
  expect(button.getAttribute("data-save-state")).toBe("saving");
  expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => {
    complete();
    await pending;
  });
  await show(<SaveStatusButton dirty={false} onSave={onSave} />);
  expect(button.getAttribute("data-save-state")).toBe("saved");
  expect(button.getAttribute("title")).toBe("Saved on this device");
  expect(button.querySelector(".lucide-hard-drive")).not.toBeNull();
});

it("retains descriptions after failed saves and retries from the same popup", async () => {
  const error = Error("Disk full");
  const onSave = vi
    .fn<(description?: string) => Promise<void>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(undefined);
  await show(<SaveStatusButton dirty canDescribe onSave={onSave} />);
  const save = document.querySelector("button")!;
  await act(async () =>
    save.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        altKey: true,
        key: "ArrowDown",
      }),
    ),
  );
  const input = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Version description"]',
  )!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "Keep this description");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(save.getAttribute("data-save-state")).toBe("error");
  expect(notify.error).toHaveBeenCalledWith(error);
  expect(input.value).toBe("Keep this description");
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onSave).toHaveBeenNthCalledWith(1, "Keep this description");
  expect(onSave).toHaveBeenNthCalledWith(2, "Keep this description");
  expect(save.getAttribute("data-save-state")).toBe("dirty");
});
