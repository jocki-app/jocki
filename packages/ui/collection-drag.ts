import { LexoRank } from "lexorank";
import {
  compareValues,
  type Field,
  type RecordSchema,
  type Value,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import {
  activeGroups,
  groupRecords,
  groupKey,
  resolveGroupPath,
  type CollectionViewState,
  type GroupSegment,
} from "./collection-view-model";

export interface RowDrop {
  rowId: string;
  path: GroupSegment[];
  /** Center drop: make this record the destination, even before it has children. */
  targetId?: string;
  anchorId?: string;
  position?: "before" | "after";
}
export interface RowMovePatch {
  row: ResourceRecord;
  patch: Record<string, Value>;
}
export const sortingRule = (schema: RecordSchema, state: CollectionViewState) =>
  state.query.sorts?.find(
    (sort) =>
      sort.enabled !== false &&
      schema.fields.some(
        (f) => f.id === sort.field && f.control === "sorting" && !f.array,
      ),
  );

/** Natural membership, before a referenced row is moved into its own heading. */
export function rowGroupPaths(
  rows: ResourceRecord[],
  schema: RecordSchema,
  state: CollectionViewState,
) {
  const paths = new Map<string, GroupSegment[]>();
  const pending = groupRecords(
    rows,
    activeGroups(state.groups, schema.fields).map((f) => ({
      ...f,
      groupMaterialize: false,
    })),
  );
  if (!pending.length) rows.forEach((row) => paths.set(row.id, []));
  while (pending.length) {
    const node = pending.pop()!;
    node.directRows?.forEach((row) => paths.set(row.id, node.path));
    pending.push(...node.children);
  }
  return paths;
}
const samePath = (a: GroupSegment[], b: GroupSegment[]) =>
  JSON.stringify(a) === JSON.stringify(b);
export const referenceIdentity = (row: ResourceRecord, f: Field) =>
  f.referenceField === "uid" ? (row.data.uid ?? row.id) : row.id;
export const isReferenceTarget = (row: ResourceRecord, f: Field) =>
  (f.reference === "resources" || row.collection === f.reference) &&
  (!f.referenceTable || row.data.table_id === f.referenceTable);

/** The deepest applicable reference rule creates children; ordinary rules copy membership. */
export function rowDropReference(
  row: ResourceRecord,
  fields: ReturnType<typeof activeGroups>,
) {
  return fields.findLast(
    (f) => f.reference && !f.array && isReferenceTarget(row, f),
  );
}

/** Descendants follow active reference grouping fields, independent of filtering/collapse. */
export function planRowDeletion(
  rows: ResourceRecord[],
  schema: RecordSchema,
  state: CollectionViewState,
  ids: string[],
) {
  if (!ids.length) return [];
  const children = new Map<string, Set<string>>();
  for (const field of activeGroups(state.groups, schema.fields).filter(
    (f) => f.reference,
  )) {
    const scalar = { ...field, array: false };
    const targets = new Map<string, string | null>();
    for (const row of rows) {
      if (!isReferenceTarget(row, field)) continue;
      const key = groupKey(scalar, referenceIdentity(row, field));
      targets.set(key, targets.has(key) ? null : row.id);
    }
    for (const row of rows) {
      const value = row.data[field.id];
      for (const reference of field.array && Array.isArray(value)
        ? value
        : [value]) {
        if (reference == null || reference === "") continue;
        const parent = targets.get(groupKey(scalar, reference));
        if (!parent) continue;
        const descendants = children.get(parent) ?? new Set<string>();
        descendants.add(row.id);
        children.set(parent, descendants);
      }
    }
  }
  const selected = new Set(ids),
    pending = [...ids];
  while (pending.length)
    for (const child of children.get(pending.pop()!) ?? []) {
      if (selected.has(child)) continue;
      selected.add(child);
      pending.push(child);
    }
  return rows.filter((row) => selected.has(row.id));
}

/** Compute writes without touching storage. The host validates permissions and persists them. */
export function planRowMove(
  rows: ResourceRecord[],
  schema: RecordSchema,
  state: CollectionViewState,
  drop: RowDrop,
  allRows = rows,
): RowMovePatch[] {
  const row = rows.find((row) => row.id === drop.rowId);
  if (!row) throw Error("This entry is no longer in the view.");
  if (drop.anchorId === row.id) return [];
  const fields = activeGroups(state.groups, schema.fields);
  const paths = rowGroupPaths(rows, schema, state);
  const anchor = rows.find(
    (candidate) => candidate.id === (drop.targetId ?? drop.anchorId),
  );
  if ((drop.targetId || drop.anchorId) && !anchor)
    throw Error("The destination row is no longer available.");
  if (drop.targetId === row.id) return [];
  const patch: Record<string, Value> = {};
  if (anchor) {
    if (drop.anchorId && !samePath(paths.get(anchor.id) ?? [], drop.path))
      throw Error("The destination row has moved. Try again.");
    for (const f of fields) patch[f.id] = anchor.data[f.id] ?? null;
    if (drop.targetId) {
      const reference = rowDropReference(anchor, fields);
      if (reference) patch[reference.id] = referenceIdentity(anchor, reference);
    }
  } else {
    const tree = groupRecords(rows, fields);
    const { ancestors } = resolveGroupPath(tree, drop.path);
    if (ancestors.length !== drop.path.length)
      throw Error("This group is no longer available.");
    for (const f of fields) {
      const target = ancestors.findLast((node) => node.field.id === f.id);
      if (target) patch[f.id] = target.value;
      else if (f.groupMode === "recursive" && f.reference && !f.array)
        patch[f.id] = null;
    }
  }
  for (const f of fields) {
    if (
      !Object.hasOwn(patch, f.id) ||
      compareValues(f, row.data[f.id], patch[f.id]) === 0
    )
      continue;
    if (f.generated || f.visibility === "viewable")
      throw Error(`${f.label} is read-only.`);
    if (patch[f.id] == null && (!f.nullable || f.required))
      throw Error(`${f.label} requires a value.`);
    if (
      !f.reference ||
      f.array ||
      (f.groupMode !== "recursive" && f.relationship !== "parent")
    )
      continue;
    // Resolve typed identifiers from the full table, including filtered-out ancestors.
    const targets = new Map<string, ResourceRecord | null>();
    for (const candidate of allRows) {
      if (!isReferenceTarget(candidate, f)) continue;
      const key = groupKey(f, referenceIdentity(candidate, f));
      targets.set(key, targets.has(key) ? null : candidate);
    }
    const visited = new Set<string>();
    let value = patch[f.id];
    while (value != null && value !== "") {
      if (
        isReferenceTarget(row, f) &&
        compareValues(f, referenceIdentity(row, f), value) === 0
      )
        throw Error(
          "An entry cannot be moved under itself or one of its descendants.",
        );
      const target = targets.get(groupKey(f, value));
      if (!target) break;
      if (visited.has(target.id))
        throw Error("This destination contains a reference cycle.");
      visited.add(target.id);
      value = target.data[f.id];
    }
  }
  const planned = new Map<string, RowMovePatch>();
  const set = (target: ResourceRecord, values: Record<string, Value>) => {
    const existing = planned.get(target.id) ?? { row: target, patch: {} };
    Object.assign(existing.patch, values);
    planned.set(target.id, existing);
  };
  set(row, patch);
  const sort = sortingRule(schema, state);
  if (sort) {
    const rankField = schema.fields.find((f) => f.id === sort.field)!;
    if (rankField.generated || rankField.visibility === "viewable")
      throw Error(`${rankField.label} is read-only.`);
    const prefix = (state.query.sorts ?? [])
      .filter((s) => s.enabled !== false)
      .slice(
        0,
        (state.query.sorts ?? [])
          .filter((s) => s.enabled !== false)
          .indexOf(sort),
      );
    const moved = { ...row.data, ...patch };
    const matchesPrefix = (candidate: ResourceRecord) =>
      prefix.every((s) => {
        const f = schema.fields.find((f) => f.id === s.field);
        return !f || compareValues(f, moved[f.id], candidate.data[f.id]) === 0;
      });
    const anchor = rows.find((r) => r.id === drop.anchorId);
    if (anchor && !matchesPrefix(anchor))
      throw Error(
        "Place the Sorting column first in Sort to reorder across other sort values.",
      );
    const destinationPaths = rowGroupPaths(
      rows.map((candidate) =>
        candidate.id === row.id ? { ...candidate, data: moved } : candidate,
      ),
      schema,
      state,
    );
    const destinationPath = destinationPaths.get(row.id) ?? [];
    const peers = rows.filter(
      (candidate) =>
        candidate.id !== row.id &&
        samePath(destinationPaths.get(candidate.id) ?? [], destinationPath) &&
        matchesPrefix(candidate),
    );
    const anchorIndex = anchor
      ? peers.findIndex((r) => r.id === anchor.id)
      : peers.length;
    if (anchor && anchorIndex < 0)
      throw Error("The destination row belongs to another subgroup.");
    const index = anchor
      ? anchorIndex + (drop.position === "after" ? 1 : 0)
      : peers.length;
    const sequence = [...peers.slice(0, index), row, ...peers.slice(index)];
    const parse = (target?: ResourceRecord) => {
      if (!target) return undefined;
      const value = target.data[sort.field];
      if (
        typeof value !== "string" ||
        !/^[012]\|[0-9a-z]+:[0-9a-z]*$/.test(value)
      )
        return undefined;
      try {
        return LexoRank.parse(value);
      } catch {
        return undefined;
      }
    };
    // Work in ascending rank order. Repair only the smallest adjacent interval
    // with usable bounds; other siblings and all descendants keep their ranks.
    const ordered =
      sort.direction === "desc" ? [...sequence].reverse() : sequence;
    let start = ordered.findIndex((candidate) => candidate.id === row.id),
      end = start + 1;
    while (true) {
      const lower = parse(ordered[start - 1]),
        upper = parse(ordered[end]);
      if (start > 0 && !lower) {
        start--;
        continue;
      }
      if (end < ordered.length && !upper) {
        end++;
        continue;
      }
      try {
        if (lower && upper && lower.compareTo(upper) >= 0)
          throw Error("Overlapping ranks");
        const ranks: LexoRank[] = [];
        if (!lower && upper) {
          let rank = upper;
          for (let i = start; i < end; i++) {
            rank = rank.genPrev();
            ranks.unshift(rank);
          }
        } else {
          let rank = lower;
          for (let i = start; i < end; i++) {
            rank = rank
              ? upper
                ? rank.between(upper)
                : rank.genNext()
              : LexoRank.middle();
            ranks.push(rank);
          }
        }
        if (
          (lower && ranks[0].compareTo(lower) <= 0) ||
          (upper && ranks.at(-1)!.compareTo(upper) >= 0) ||
          ranks.some(
            (rank, index) => index > 0 && ranks[index - 1].compareTo(rank) >= 0,
          )
        )
          throw Error("No space between ranks");
        ranks.forEach((rank, i) =>
          set(ordered[start + i], { [sort.field]: rank.toString() }),
        );
        break;
      } catch {
        if (end < ordered.length) end++;
        else if (start > 0) start--;
        else throw Error("Unable to generate sorting values.");
      }
    }
  } else if (!fields.length) return [];
  return (
    [...planned.values()]
      // Repair siblings first so a failure cannot acknowledge a half-finished move.
      .sort((a, b) => Number(a.row.id === row.id) - Number(b.row.id === row.id))
      .map(({ row, patch }) => ({
        row,
        patch: Object.fromEntries(
          Object.entries(patch).filter(
            ([key, value]) =>
              JSON.stringify(row.data[key] ?? null) !== JSON.stringify(value),
          ),
        ),
      }))
      .filter((item) => Object.keys(item.patch).length)
  );
}
