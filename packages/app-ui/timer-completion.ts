import type { AppRuntime } from "./runtime";
/** Only an explicit, device-local Time submission authorizes this completion write.
 * Received replica records never create submissions or invoke commands.
 */
export async function finishLocalTimeTimers(runtime: AppRuntime) {
  const due = runtime.timers
    .list()
    .filter((t) => t.pluginId === "time" && t.completedAt !== undefined);
  if (
    !due.length ||
    !runtime.registry.enabled("time") ||
    !runtime.node.records.canWrite()
  )
    return;
  const store = runtime.collection("time", true);
  for (const timer of due) {
    const row = store.get
      ? await store.get(timer.id)
      : (await store.list()).find((r) => r.id === timer.id);
    if (
      !row ||
      row.collection !== "time" ||
      row.data.ended_at ||
      row.data.paused_at ||
      Date.parse(String(row.data.started_at)) !== timer.startedAt ||
      Number(row.data.target_seconds) * 1000 !== timer.durationMs
    )
      continue;
    await store.put(
      {
        ...row.data,
        ended_at: new Date(timer.completedAt!).toISOString(),
        paused_at: null,
      },
      row.id,
    );
  }
}
