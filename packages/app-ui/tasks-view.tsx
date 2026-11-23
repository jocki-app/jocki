import type { AppRuntime } from "./runtime";
import { RecordTable } from "./record-table";
/** Task status is edited through the shared inline field controls. */
export function TasksView({ runtime }: { runtime: AppRuntime }) {
  return <RecordTable runtime={runtime} collection="tasks" />;
}
