import { calendarFields } from "./calendar-model";
import {
  compareValues,
  decodeField,
  type Field,
  type Query,
  type Value,
  type RecordSchema,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";

export const viewModes = [
  "short-table",
  "long-table",
  "board",
  "short-table-folder",
  "long-table-folder",
  "board-folder",
  "list",
  "week",
  "month",
] as const;
export type ViewMode = (typeof viewModes)[number];
export const viewLabels: Record<ViewMode, string> = {
  "short-table": "Short table",
  "long-table": "Long table",
  board: "Board",
  list: "List",
  week: "Week",
  month: "Month",
  "short-table-folder": "Short table folder",
  "long-table-folder": "Long table folder",
  "board-folder": "Board folder",
};
export function availableViewModes(fields: Field[]) {
  return viewModes.filter(
    (mode) =>
      !["list", "week", "month"].includes(mode) ||
      calendarFields(fields).length > 0,
  );
}
export interface Grouping {
  id: string;
  field: string;
  enabled: boolean;
  labelField?: string;
  mode?: "individual" | "recursive";
  materialize?: boolean;
}
export interface GroupSegment {
  field: string;
  key: string;
}
export interface CollectionViewState {
  version: 2;
  query: Query;
  columns: string[];
  /** Full field order, including hidden columns; older callers may omit it. */
  columnOrder?: string[];
  groups: Grouping[];
  mode: ViewMode;
  dateField?: string;
  path: GroupSegment[];
  collapsed: string[];
}
export interface GroupNode {
  id: string;
  field: Field;
  value: Value;
  path: GroupSegment[];
  rows: ResourceRecord[];
  children: GroupNode[];
  /** Rows rendered at this node; rows includes all descendants for counts/labels. */
  directRows?: ResourceRecord[];
  labelField?: Field;
  /** Referenced items moved from their normal position into this heading. */
  materializedRows?: ResourceRecord[];
  /** Parentless records in a recursive reference rule stay at the current level. */
  ungrouped?: boolean;
}

/** Keep hidden fields in the same order so toggling visibility never moves them. */
export function resolveColumnOrder(
  fields: Field[],
  preferred: string[] = [],
): string[] {
  const ids = new Set(fields.map((field) => field.id));
  return [...new Set([...preferred.filter((id) => ids.has(id)), ...ids])];
}

/** Descriptor visibility selects defaults, not which columns can be chosen. */
export function defaultVisibleColumns(fields: Field[]): string[] {
  return fields
    .filter(
      (field) =>
        !["hidden", "addable"].includes(field.visibility ?? "editable"),
    )
    .map((field) => field.id);
}

/** Display preferences are local; search from older table preferences is deliberately retired. */
export function normalizeView(
  saved: Partial<CollectionViewState> | undefined,
  schema: RecordSchema,
): CollectionViewState {
  const ids = new Set(schema.fields.map((f) => f.id));
  const columns = [
    ...new Set(
      (saved?.columns ?? defaultVisibleColumns(schema.fields)).filter((id) =>
        ids.has(id),
      ),
    ),
  ];
  const columnOrder = resolveColumnOrder(
    schema.fields,
    saved?.columnOrder ?? saved?.columns ?? [],
  );
  const query = saved?.query ?? {};
  const { search: _search, groupBy, ...rest } = query;
  const groups =
    saved?.groups ??
    (groupBy && ids.has(groupBy)
      ? [{ id: "legacy-" + groupBy, field: groupBy, enabled: true }]
      : []);
  const view: CollectionViewState = {
    version: 2,
    query: {
      ...rest,
      filters: rest.filters?.filter((f) => ids.has(f.field)),
      sorts: rest.sorts?.filter((s) => ids.has(s.field)),
    },
    columns: columnOrder.filter((id) => columns.includes(id)),
    columnOrder,
    groups: groups
      .map((group) => recursiveGrouping(group, schema.fields))
      .filter((g) => ids.has(g.field)),
    dateField: calendarFields(schema.fields).find(
      (f) => f.id === saved?.dateField,
    )?.id,
    mode: availableViewModes(schema.fields).includes(saved?.mode as ViewMode)
      ? saved!.mode!
      : "short-table",
    path: saved?.path ?? [],
    collapsed: saved?.collapsed ?? [],
  };
  // View preferences are JSON. Omit unset optional properties, including cleared
  // group labels, before a caller assigns this value to an Automerge document.
  return JSON.parse(JSON.stringify(view)) as CollectionViewState;
}
export function moveRule<T>(rules: T[], index: number, direction: -1 | 1): T[] {
  const to = index + direction;
  if (to < 0 || to >= rules.length) return rules;
  const next = [...rules];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
function canonical(value: Value): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function groupKey(field: Field, value: Value | undefined): string {
  if (value == null) return "null";
  let normalized: Value = value;
  try {
    normalized = decodeField(field, value);
  } catch {
    /* Opaque newer values remain visible. */
  }
  if (field.array && Array.isArray(normalized))
    return (
      "[" +
      normalized.map((v) => groupKey({ ...field, array: false }, v)).join(",") +
      "]"
    );
  if (
    (field.pgType === "numeric" || field.pgType === "bigint") &&
    /^-?\d+(\.\d+)?$/.test(String(normalized))
  ) {
    const [whole, fraction = ""] = String(normalized).split(".");
    const decimals = fraction.replace(/0+$/, "");
    const integer = BigInt(whole).toString();
    return JSON.stringify(
      (String(normalized).startsWith("-") && integer === "0" && decimals
        ? "-"
        : "") +
        integer +
        (decimals ? "." + decimals : ""),
    );
  }
  if (
    field.pgType === "timestamp with time zone" &&
    Number.isFinite(Date.parse(String(normalized)))
  ) {
    return JSON.stringify(
      (
        BigInt(Date.parse(String(normalized))) * 1000n +
        BigInt(
          (String(normalized).match(/\.(\d+)/)?.[1] ?? "")
            .padEnd(6, "0")
            .slice(3, 6),
        )
      ).toString(),
    );
  }
  return canonical(normalized);
}
export type GroupField = Field & {
  groupMode?: "individual" | "recursive";
  groupLabelField?: Field;
  groupMaterialize?: boolean;
  groupMaterializeField?: Field;
};
/** A recursive materialized label identifies the ancestry, not an unrelated bucket. */
function recursiveGrouping(group: Grouping, fields: Field[]): Grouping {
  const reference = fields.find((field) => field.id === group.labelField);
  return group.mode === "recursive" &&
    group.materialize &&
    reference?.reference &&
    !reference.array
    ? { ...group, field: reference.id }
    : group;
}
export function activeGroups(
  groups: Grouping[],
  fields: Field[],
): GroupField[] {
  const seen = new Set<string>();
  return groups
    .map((group) => recursiveGrouping(group, fields))
    .flatMap((g) => {
      const field = fields.find((f) => f.id === g.field);
      if (!g.enabled || !field || seen.has(g.field)) return [];
      seen.add(g.field);
      const labelField = fields.find((f) => f.id === g.labelField);
      const materializeField = labelField ?? field;
      return [
        {
          ...field,
          groupMode: g.mode,
          groupMaterialize: !!materializeField.reference && g.materialize,
          groupMaterializeField: materializeField,
          groupLabelField: labelField,
        },
      ];
    });
}
/** Labels aggregate distinct typed values without changing membership or group identity. */
export function groupLabelValues(node: GroupNode): Value[] {
  // A grouping field names the bucket itself. Materialized parents and recursive
  // descendants may have different values without changing that bucket's key.
  if (!node.labelField || node.labelField.id === node.field.id)
    return [node.value];
  const values = new Map<string, Value>();
  for (const row of node.rows) {
    const value = row.data[node.labelField.id] ?? null;
    const key = groupKey(node.labelField, value);
    if (!values.has(key)) values.set(key, value);
  }
  return [...values.values()];
}

export function groupRecords(
  rows: ResourceRecord[],
  fields: GroupField[],
  depth = 0,
  parent: GroupSegment[] = [],
): GroupNode[] {
  const tree = buildGroups(rows, fields, depth, parent);
  if (!fields.some((field) => field.groupMaterialize)) return tree;
  const targets = new Map<string, Map<string, ResourceRecord | null>>();
  for (const group of fields.filter((f) => f.groupMaterialize)) {
    const field = group.groupMaterializeField ?? group;
    const index = new Map<string, ResourceRecord | null>();
    for (const row of rows) {
      if (field.reference !== "resources" && row.collection !== field.reference)
        continue;
      if (field.referenceTable && row.data.table_id !== field.referenceTable)
        continue;
      const identity =
        field.referenceField === "uid" ? (row.data.uid ?? row.id) : row.id;
      const key = groupKey({ ...field, array: false }, identity);
      index.set(key, index.has(key) ? null : row);
    }
    targets.set(group.id, index);
  }
  // A record has one editable location even when several rules reference it.
  // Resolve ownership before removing natural rows so cycles cannot lose items.
  const moved = new Set<string>();
  const ordered: GroupNode[] = [],
    pending = [...tree].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    ordered.push(node);
    const index = targets.get(node.field.id);
    if (index) {
      const reference =
        fields.find((f) => f.id === node.field.id)?.groupMaterializeField ??
        node.field;
      const sourceValues =
        reference.id === node.field.id
          ? [node.value]
          : node.rows.map((row) => row.data[reference.id]);
      const values = sourceValues.flatMap((value) =>
        reference.array && Array.isArray(value) ? value : [value],
      );
      node.materializedRows = values.flatMap((value) => {
        const row =
          value == null
            ? undefined
            : index.get(groupKey({ ...reference, array: false }, value));
        if (!row || moved.has(row.id)) return [];
        moved.add(row.id);
        return [row];
      });
    }
    pending.push(...[...node.children].reverse());
  }
  // A materialized recursive group replaces its parent's natural row slot,
  // including slots inside subsequent grouping rules (for example, status).
  const locations = new Map<string, GroupNode>();
  const owners = new Map<GroupNode, GroupNode>();
  for (const node of ordered) {
    node.directRows?.forEach((row) => locations.set(row.id, node));
    node.children.forEach((child) => owners.set(child, node));
  }
  let relocated = false;
  for (const node of ordered) {
    const rule = fields.find((field) => field.id === node.field.id);
    if (
      rule?.groupMode !== "recursive" ||
      node.materializedRows?.length !== 1 ||
      (rule.groupMaterializeField ?? rule).id !== rule.id
    )
      continue;
    const destination = locations.get(node.materializedRows[0].id);
    if (
      !destination ||
      destination === node ||
      destination.ungrouped ||
      owners.get(node) === destination
    )
      continue;
    let ancestor: GroupNode | undefined = destination;
    while (ancestor && ancestor !== node) ancestor = owners.get(ancestor);
    if (ancestor) continue;
    const siblings = owners.get(node)?.children ?? tree;
    siblings.splice(siblings.indexOf(node), 1);
    destination.children.push(node);
    owners.set(node, destination);
    relocated = true;
  }
  if (relocated) {
    ordered.length = 0;
    const walk = tree.map((node) => ({ node, path: parent }));
    while (walk.length) {
      const { node, path } = walk.pop()!;
      const membership = [
        ...path,
        { field: node.field.id, key: groupKey(node.field, node.value) },
      ];
      node.id = JSON.stringify(membership);
      node.path = node.ungrouped ? path : membership;
      ordered.push(node);
      walk.push(
        ...node.children.map((child) => ({ node: child, path: node.path })),
      );
    }
  }
  for (const node of ordered.reverse()) {
    node.directRows = (node.directRows ?? []).filter(
      (row) => !moved.has(row.id),
    );
    node.children = node.children.filter((child) => child.rows.length);
    node.rows = [
      ...(node.materializedRows ?? []),
      ...node.directRows,
      ...node.children.flatMap((child) => child.rows),
    ];
  }
  return tree.filter((node) => node.rows.length);
}

function buildGroups(
  rows: ResourceRecord[],
  fields: GroupField[],
  depth = 0,
  parent: GroupSegment[] = [],
): GroupNode[] {
  const field = fields[depth];
  if (!field) return [];
  const recursiveReference =
    field.groupMode === "recursive" && !!field.reference && !field.array;
  const buckets = new Map<string, { value: Value; rows: ResourceRecord[] }>();
  for (const row of rows) {
    const rawValue = row.data[field.id];
    const value =
        recursiveReference && rawValue === "" ? null : (rawValue ?? null),
      key = groupKey(field, value);
    const bucket = buckets.get(key) ?? { value, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  const ordered = [...buckets.keys()].sort((a, b) =>
    compareValues(field, buckets.get(a)!.value, buckets.get(b)!.value),
  );
  const parents = new Map<string, string>();
  // Only declared scalar references can create ancestry. Plain values stay individual.
  if (recursiveReference) {
    const targets = new Map<string, ResourceRecord | null>();
    for (const row of rows) {
      if (field.reference !== "resources" && row.collection !== field.reference)
        continue;
      if (field.referenceTable && row.data.table_id !== field.referenceTable)
        continue;
      const identity =
        field.referenceField === "uid" ? (row.data.uid ?? row.id) : row.id;
      const key = groupKey(field, identity);
      targets.set(key, targets.has(key) ? null : row);
    }
    for (const [key, bucket] of buckets) {
      if (bucket.value == null) continue;
      const target = targets.get(key);
      if (!target) continue;
      const parentValue = target.data[field.id];
      if (parentValue == null || parentValue === "") continue;
      const parentKey = groupKey(field, parentValue);
      if (buckets.has(parentKey) && parentKey !== key)
        parents.set(key, parentKey);
    }
    // Break one edge per cycle deterministically, including with reordered input.
    const visited = new Set<string>();
    for (const start of [...buckets.keys()].sort()) {
      const chain: string[] = [],
        positions = new Map<string, number>();
      let key: string | undefined = start;
      while (key !== undefined && !visited.has(key)) {
        if (positions.has(key)) {
          parents.delete(chain.slice(positions.get(key)).sort()[0]);
          break;
        }
        positions.set(key, chain.length);
        chain.push(key);
        key = parents.get(key);
      }
      chain.forEach((key) => visited.add(key));
    }
  }
  const nodes = new Map<string, GroupNode>();
  for (const key of ordered) {
    const bucket = buckets.get(key)!;
    nodes.set(key, {
      id: "",
      field,
      value: bucket.value,
      path: [],
      rows: [...bucket.rows],
      directRows: bucket.rows,
      children: [],
      labelField: field.groupLabelField,
      ungrouped: recursiveReference && bucket.value == null,
    });
  }
  const roots: GroupNode[] = [];
  for (const key of ordered) {
    const node = nodes.get(key)!,
      ancestor = nodes.get(parents.get(key) ?? "");
    if (ancestor) ancestor.children.push(node);
    else roots.push(node);
  }
  // Iterative ancestry walk avoids stack overflow for long reference chains.
  const pending = roots.map((node) => ({ node, path: parent })),
    traversal: GroupNode[] = [];
  while (pending.length) {
    const { node, path } = pending.pop()!;
    node.path = [
      ...path,
      { field: field.id, key: groupKey(field, node.value) },
    ];
    node.id = JSON.stringify(node.path);
    if (node.ungrouped) node.path = path;
    traversal.push(node);
    for (const child of node.children)
      pending.push({ node: child, path: node.path });
  }
  for (const node of traversal.reverse()) {
    const recursiveChildren = node.children;
    node.rows = [
      ...node.rows,
      ...recursiveChildren.flatMap((child) => child.rows),
    ];
    const subgroups = buildGroups(
      node.directRows!,
      fields,
      depth + 1,
      node.path,
    );
    if (subgroups.length) node.directRows = [];
    node.children = [...subgroups, ...recursiveChildren];
  }
  return roots;
}
/** Resolve the longest valid prefix after changes to grouping, filters or data. */
export function resolveGroupPath(
  tree: GroupNode[],
  path: GroupSegment[],
): {
  ancestors: GroupNode[];
  children: GroupNode[];
  directRows: ResourceRecord[];
} {
  const ancestors: GroupNode[] = [];
  const level = (nodes: GroupNode[]) => {
    const children: GroupNode[] = [],
      directRows: ResourceRecord[] = [];
    const pending = [...nodes].reverse();
    while (pending.length) {
      const node = pending.pop()!;
      if (node.ungrouped) {
        directRows.push(
          ...(node.materializedRows ?? []),
          ...(node.directRows ?? []),
        );
        pending.push(...[...node.children].reverse());
      } else children.push(node);
    }
    return { children, directRows };
  };
  let { children, directRows } = level(tree);
  for (const segment of path) {
    const node = children.find(
      (n) => n.field.id === segment.field && n.path.at(-1)?.key === segment.key,
    );
    if (!node) break;
    ancestors.push(node);
    const next = level(node.children);
    children = next.children;
    directRows = [...(node.directRows ?? []), ...next.directRows];
  }
  return { ancestors, children, directRows };
}

/** Include collapsed descendants so the depth controls never disappear on collapse. */
export function groupLevels(tree: GroupNode[], path: GroupSegment[] = []) {
  const { ancestors, children } = resolveGroupPath(tree, path);
  const levels = new Map<number, GroupNode[]>();
  const add = (node: GroupNode) => {
    if (node.ungrouped) return;
    const depth = node.path.length;
    const nodes = levels.get(depth) ?? [];
    nodes.push(node);
    levels.set(depth, nodes);
  };
  ancestors.forEach(add);
  const pending = [...children];
  while (pending.length) {
    const node = pending.pop()!;
    add(node);
    pending.push(...node.children);
  }
  return [...levels]
    .sort(([a], [b]) => a - b)
    .map(([depth, nodes]) => ({ depth, nodes }));
}

/** A mixed level collapses together; a fully collapsed level expands together. */
export function toggleGroupLevel(collapsed: string[], nodes: GroupNode[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const closed = new Set(collapsed);
  return nodes.length && nodes.every((node) => closed.has(node.id))
    ? collapsed.filter((id) => !ids.has(id))
    : [...new Set([...collapsed, ...ids])];
}

export type GroupEntry =
  | { kind: "row"; row: ResourceRecord; path: GroupSegment[] }
  | { kind: "group"; node: GroupNode };

/** Materialized parents and leaves occupy the same ordered sibling slots. */
export function orderedGroupEntries(
  nodes: GroupNode[],
  directRows: ResourceRecord[],
  path: GroupSegment[],
  order: ReadonlyMap<string, number>,
): GroupEntry[] {
  const entries: GroupEntry[] = directRows.map((row) => ({
    kind: "row",
    row,
    path,
  }));
  const pending = [...nodes].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (node.ungrouped) {
      entries.push(
        ...[...(node.materializedRows ?? []), ...(node.directRows ?? [])].map(
          (row) => ({ kind: "row" as const, row, path: node.path }),
        ),
      );
      pending.push(...[...node.children].reverse());
    } else entries.push({ kind: "group", node });
  }
  const row = (entry: GroupEntry) =>
    entry.kind === "row" ? entry.row : entry.node.materializedRows?.[0];
  const ordered = entries
    .filter((entry) => row(entry))
    .sort(
      (a, b) =>
        (order.get(row(a)!.id) ?? Infinity) -
        (order.get(row(b)!.id) ?? Infinity),
    );
  let index = 0;
  return entries.map((entry) => (row(entry) ? ordered[index++] : entry));
}

/** Selection follows the current breadcrumb and excludes collapsed/folder-only branches. */
export function visibleRecords(
  rows: ResourceRecord[],
  schema: RecordSchema,
  state: CollectionViewState,
) {
  const tree = groupRecords(rows, activeGroups(state.groups, schema.fields));
  const { ancestors, children, directRows } = resolveGroupPath(
    tree,
    state.path,
  );
  const pinned = ancestors.flatMap((node) => node.materializedRows ?? []);
  if (ancestors.some((node) => state.collapsed.includes(node.id)))
    return pinned;
  if (state.mode.endsWith("-folder") && children.length)
    return [
      ...pinned,
      ...directRows,
      ...children.flatMap((node) => node.materializedRows ?? []),
    ];
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const collect = (
    nodes: GroupNode[],
    direct: ResourceRecord[],
    path: GroupSegment[],
  ): ResourceRecord[] =>
    orderedGroupEntries(nodes, direct, path, order).flatMap((entry) => {
      if (entry.kind === "row") return [entry.row];
      const node = entry.node;
      return [
        ...(node.materializedRows ?? []),
        ...(!state.collapsed.includes(node.id)
          ? collect(node.children, node.directRows ?? [], node.path)
          : []),
      ];
    });
  return [
    ...pinned,
    ...collect(children, tree.length ? directRows : rows, state.path),
  ];
}
export function groupDefaults(
  rows: ResourceRecord[],
  schema: RecordSchema,
  state: CollectionViewState,
): Record<string, Value> {
  const { ancestors } = resolveGroupPath(
    groupRecords(rows, activeGroups(state.groups, schema.fields)),
    state.path,
  );
  return Object.fromEntries(
    ancestors.map((node) => [node.field.id, node.value]),
  );
}
