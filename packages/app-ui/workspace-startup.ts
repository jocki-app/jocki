import type { NativeRuntimeEvent } from "../platform-native/diagnostics";
/** A process killed while opening must not auto-open the same workspace forever. */
export const workspaceOpeningKey = "jocki.opening-workspace";
const stageKey = "jocki.opening-stage";
const startedKey = "jocki.opening-started";
export function workspaceOpenFailure(
  storage: Storage,
  events: NativeRuntimeEvent[] = [],
) {
  const stage = workspaceOpenStage(storage) ?? "startup";
  const started = Number(storage.getItem(startedKey));
  const relevant = events.filter(
    (event) => started > 0 && Date.parse(event.at) >= started - 1000,
  );
  const terminated = relevant.some(
    (event) => event.type === "web-content-terminated",
  );
  const memory = relevant.some((event) => event.type === "memory-warning");
  const reason = terminated
    ? "iOS terminated the app’s web process. "
    : memory
      ? "iOS reported memory pressure. "
      : "";
  return Object.assign(
    new Error(
      `${reason}Workspace opening was interrupted during ${stage}. Choose Open to try again. Your saved data is retained.`,
    ),
    {
      kind: terminated
        ? "WEB_CONTENT_TERMINATED"
        : "WORKSPACE_OPEN_INTERRUPTED",
    },
  );
}
export const workspaceOpenStage = (storage: Storage) =>
  storage.getItem(stageKey);
export function workspaceOpenProgress(
  storage: Storage,
  id: string,
  phase: string,
) {
  if (storage.getItem(workspaceOpeningKey) === id)
    storage.setItem(stageKey, phase);
}
export function beginWorkspaceOpen(storage: Storage, id: string) {
  storage.setItem(workspaceOpeningKey, id);
  storage.setItem(stageKey, "Preparing workspace…");
  storage.setItem(startedKey, String(Date.now()));
}
export function finishWorkspaceOpen(storage: Storage, id: string) {
  if (storage.getItem(workspaceOpeningKey) === id) {
    storage.removeItem(workspaceOpeningKey);
    storage.removeItem(stageKey);
    storage.removeItem(startedKey);
  }
}
export function interruptedWorkspaceOpen(storage: Storage): boolean {
  const interrupted = storage.getItem(workspaceOpeningKey) !== null;
  storage.removeItem(workspaceOpeningKey);
  storage.removeItem(stageKey);
  storage.removeItem(startedKey);
  return interrupted;
}
