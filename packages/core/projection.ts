import { schemaById } from "@jocki/platform/core/catalog";
import type { Replica } from "./replica";
import { canonical } from "./crypto";
import type { StoredDocument } from "../storage/projection";

export interface ProjectionCheckpoint {
  id: string;
  source: string;
  heads: string[];
  contract: string;
}
export interface ProjectionBatch {
  documents: StoredDocument[];
  removed: string[];
  checkpoints: ProjectionCheckpoint[];
}
export interface ProjectionSink {
  load(): Promise<ProjectionCheckpoint[]>;
  /** Commit rows, removals and checkpoints together, durably. */
  apply(batch: ProjectionBatch): Promise<void>;
}

/** A local secondary index. Automerge remains authoritative; checkpoints are
 * advanced only after the sink commits. Reopening reconciles missed changes. */
export class DocumentProjection {
  private checkpoints?: Map<string, ProjectionCheckpoint>;
  private dirty = new Set<string>();
  private reconcile = true;
  private contracts = "";
  private dependencies = new Map<string, string[]>();
  private dependents = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private listener = (id: string) => this.invalidate(id);
  constructor(
    private replica: Replica,
    private sink: ProjectionSink,
    private version: string,
    listen = true,
  ) {
    if (listen) replica.listeners.add(this.listener);
  }
  invalidate(id = "") {
    if (id) this.dirty.add(id);
    else this.reconcile = true;
  }
  private references(id: string) {
    const row = this.replica.graph.target(id);
    if (!id.startsWith("record/") || !row?.data) return [];
    const data = row.data as Record<string, unknown>;
    return [data.table_id, data.schema_id, data.item_id]
      .filter((value): value is string => typeof value === "string")
      .map((value) => "record/" + value);
  }
  private indexReferences(id: string) {
    for (const reference of this.dependencies.get(id) ?? []) {
      const group = this.dependents.get(reference);
      group?.delete(id);
      if (!group?.size) this.dependents.delete(reference);
    }
    const references = this.references(id);
    this.dependencies.set(id, references);
    for (const reference of references) {
      const group = this.dependents.get(reference) ?? new Set<string>();
      group.add(id);
      this.dependents.set(reference, group);
    }
  }
  private checkpoint(id: string): ProjectionCheckpoint {
    const row = this.replica.graph.target(id);
    const references = new Set(this.dependencies.get(id) ?? []);
    for (const key of references)
      for (const parent of this.dependencies.get(key) ?? [])
        if (parent !== id) references.add(parent);
    return {
      id,
      source: this.replica.graph.source(id) ?? "",
      heads: this.replica.heads(id).slice().sort(),
      contract: canonical({
        version: this.version,
        schema: row?.collection
          ? (schemaById.get(String(row.collection)) ?? null)
          : null,
        dependencies: [...references].sort().map((key) => ({
          id: key,
          source: this.replica.graph.source(key) ?? "",
          heads: this.replica.heads(key),
        })),
      }),
    };
  }
  synchronize(rebuild = false): Promise<ProjectionBatch> {
    const next = this.queue.then(() => this.update(rebuild));
    this.queue = next.catch(() => {});
    return next;
  }
  private async update(rebuild: boolean): Promise<ProjectionBatch> {
    this.checkpoints ??= new Map(
      (await this.sink.load()).map((value) => [value.id, value]),
    );
    if (rebuild) {
      for (const checkpoint of this.checkpoints.values())
        checkpoint.contract = "";
      this.reconcile = true;
    }
    const contracts = canonical(
      [...schemaById].sort(([a], [b]) => a.localeCompare(b)),
    );
    if (contracts !== this.contracts) this.reconcile = true;
    const full = this.reconcile;
    this.reconcile = false;
    const dirty = this.dirty;
    this.dirty = new Set();
    const visible =
      full && this.replica.member
        ? new Set(this.replica.ids().filter((id) => !id.startsWith("blob/")))
        : undefined;
    const candidates = full
      ? new Set([...(visible ?? []), ...this.checkpoints.keys()])
      : new Set(dirty);
    if (full) {
      this.dependencies.clear();
      this.dependents.clear();
      for (const id of visible ?? []) this.indexReferences(id);
    } else {
      // Both old and new references matter when a row changes its parent.
      for (const id of dirty) this.indexReferences(id);
    }
    for (const id of candidates) {
      for (const dependent of this.dependents.get(id) ?? [])
        candidates.add(dependent);
    }
    const batch: ProjectionBatch = {
      documents: [],
      removed: [],
      checkpoints: [],
    };
    for (const id of candidates) {
      const reachable = visible
        ? visible.has(id)
        : Boolean(
            this.replica.member &&
            !id.startsWith("blob/") &&
            this.replica.graph.target(id) !== undefined,
          );
      if (!reachable) {
        if (this.checkpoints.has(id)) batch.removed.push(id);
        continue;
      }
      const checkpoint = this.checkpoint(id),
        previous = this.checkpoints.get(id);
      if (previous && canonical(previous) === canonical(checkpoint)) continue;
      batch.documents.push({
        id,
        value: this.replica.read(id)!,
        heads: checkpoint.heads,
      });
      batch.checkpoints.push(checkpoint);
    }
    try {
      if (batch.documents.length || batch.removed.length)
        await this.sink.apply(batch);
    } catch (error) {
      // No in-memory progress survives a failed SQL transaction or checkpoint.
      this.reconcile ||= full;
      for (const id of candidates) this.dirty.add(id);
      throw error;
    }
    for (const id of batch.removed) {
      this.checkpoints.delete(id);
      this.indexReferences(id);
    }
    for (const checkpoint of batch.checkpoints)
      this.checkpoints.set(checkpoint.id, checkpoint);
    this.contracts = contracts;
    return batch;
  }
  stop() {
    this.replica.listeners.delete(this.listener);
  }
}
