// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  beginWorkspaceOpen,
  finishWorkspaceOpen,
  interruptedWorkspaceOpen,
  workspaceOpenProgress,
  workspaceOpenStage,
  workspaceOpenFailure,
} from "../packages/app-ui/workspace-startup";
it("allows a normal reopen but detects an interrupted open once without touching workspace data", () => {
  localStorage.clear();
  localStorage.setItem("unrelated", "kept");
  beginWorkspaceOpen(localStorage, "workspace");
  workspaceOpenProgress(localStorage, "workspace", "Loading workspace data…");
  expect(workspaceOpenStage(localStorage)).toBe("Loading workspace data…");
  finishWorkspaceOpen(localStorage, "workspace");
  expect(interruptedWorkspaceOpen(localStorage)).toBe(false);
  expect(workspaceOpenStage(localStorage)).toBeNull();
  beginWorkspaceOpen(localStorage, "workspace");
  expect(interruptedWorkspaceOpen(localStorage)).toBe(true);
  expect(interruptedWorkspaceOpen(localStorage)).toBe(false);
  expect(localStorage.getItem("unrelated")).toBe("kept");
});

it("distinguishes a native process termination and memory pressure from an unknown interruption", () => {
  localStorage.clear();
  beginWorkspaceOpen(localStorage, "workspace");
  workspaceOpenProgress(
    localStorage,
    "workspace",
    "Verifying workspace documents… 64 / 2000",
  );
  const at = new Date().toISOString();
  expect(
    workspaceOpenFailure(localStorage, [
      { type: "web-content-terminated", at },
    ]),
  ).toMatchObject({ kind: "WEB_CONTENT_TERMINATED" });
  expect(
    workspaceOpenFailure(localStorage, [{ type: "memory-warning", at }])
      .message,
  ).toContain("iOS reported memory pressure");
  expect(
    workspaceOpenFailure(localStorage, [
      { type: "memory-warning", at: "2000-01-01T00:00:00Z" },
    ]).message,
  ).not.toContain("memory pressure");
  expect(workspaceOpenFailure(localStorage)).toMatchObject({
    kind: "WORKSPACE_OPEN_INTERRUPTED",
  });
  expect(workspaceOpenFailure(localStorage).message).toContain("64 / 2000");
});
