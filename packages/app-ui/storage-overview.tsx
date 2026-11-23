import type { AppRuntime } from "./runtime";
export function StorageOverview({ runtime }: { runtime: AppRuntime }) {
  return (
    <section className="space-y-3">
      <h2>Local workspace copy</h2>
      <p>
        Automerge Repo groups individual item documents by plugin and schema.
        This workspace contains {runtime.node.replica.ids("record/").length}{" "}
        records and {runtime.node.protocol.files.manifests().length} file
        versions.
      </p>
    </section>
  );
}
