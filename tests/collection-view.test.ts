import { expect, it } from "vitest";
import type {
  Field,
  RecordSchema,
  Value,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import {
  activeGroups,
  visibleRecords,
  groupDefaults,
  groupKey,
  groupRecords,
  groupLabelValues,
  groupLevels,
  toggleGroupLevel,
  moveRule,
  normalizeView,
  resolveGroupPath,
} from "../packages/ui/collection-view-model";
const field = (id: string, pgType: Field["pgType"] = "text"): Field => ({
  id,
  label: id,
  pgType,
  nullable: true,
  array: false,
  required: false,
  sensitive: false,
});
const fields = [field("status"), field("priority", "bigint")];
const schema = {
  id: "test",
  name: "Entries",
  version: 1,
  pluginId: "test",
  fields,
} as RecordSchema;
const row = (id: string, status: Value, priority: Value): ResourceRecord =>
  ({ id, data: { status, priority } }) as unknown as ResourceRecord;
it("groups recursively, retains leaf sort order and resolves only valid breadcrumb prefixes", () => {
  const rows = [
    row("a", "open", "9007199254740993"),
    row("b", "open", "9007199254740992"),
    row("c", "done", null),
    row("d", "open", "9007199254740992"),
  ];
  const tree = groupRecords(rows, fields),
    open = tree.find((n) => n.value === "open")!;
  expect(open.children.map((n) => n.value)).toEqual([
    "9007199254740992",
    "9007199254740993",
  ]);
  expect(open.children[0].rows.map((r) => r.id)).toEqual(["b", "d"]);
  const path = open.children[0].path;
  expect(resolveGroupPath(tree, path).ancestors).toHaveLength(2);
  expect(
    resolveGroupPath(
      groupRecords(
        rows.filter((r) => !["b", "d"].includes(r.id)),
        fields,
      ),
      path,
    ).ancestors,
  ).toHaveLength(1);
  expect(
    resolveGroupPath(groupRecords(rows, [fields[1], fields[0]]), path)
      .ancestors,
  ).toHaveLength(0);
});
it("uses typed, stable keys without decimal or microsecond precision loss", () => {
  expect(groupKey(fields[1], "09007199254740993")).toBe(
    groupKey(fields[1], "9007199254740993"),
  );
  expect(groupKey(fields[1], "9007199254740992")).not.toBe(
    groupKey(fields[1], "9007199254740993"),
  );
  const numeric = field("number", "numeric"),
    instant = field("time", "timestamp with time zone");
  expect(groupKey(numeric, "1.00")).toBe(groupKey(numeric, "1"));
  expect(groupKey(numeric, "-0.500")).toBe(groupKey(numeric, "-0.5"));
  expect(groupKey(numeric, "-0.5")).not.toBe(groupKey(numeric, "0.5"));
  expect(groupKey(instant, "2026-01-01T01:00:00.123456+01:00")).toBe(
    groupKey(instant, "2026-01-01T00:00:00.123456Z"),
  );
  expect(groupKey(instant, "2026-01-01T00:00:00.123456Z")).not.toBe(
    groupKey(instant, "2026-01-01T00:00:00.123457Z"),
  );
  const json = field("json", "jsonb");
  expect(groupKey(json, { b: 2, a: 1 })).toBe(groupKey(json, { a: 1, b: 2 }));
  expect(groupKey(fields[0], null)).not.toBe(groupKey(fields[0], "null"));
  expect(
    groupRecords([row("a", null, null), row("b", null, null)], fields),
  ).toHaveLength(1);
});
it("migrates old preferences, clears retired search and ignores absent schema fields", () => {
  const state = normalizeView(
    {
      query: {
        search: "invisible old search",
        groupBy: "status",
        sorts: [{ field: "missing", direction: "asc", enabled: true }],
      },
      columns: ["status", "missing", "status"],
    },
    schema,
  );
  expect(state.query).not.toHaveProperty("search");
  expect(state.query).not.toHaveProperty("groupBy");
  expect(state.groups).toEqual([
    { id: "legacy-status", field: "status", enabled: true },
  ]);
  expect(state.columns).toEqual(["status"]);
  expect(state.query.sorts).toEqual([]);
  expect(normalizeView({ columns: [] }, schema).columns).toEqual([]);
});
it("reorders enabled grouping rules without mutating the original, and ignores duplicates", () => {
  const groups = [
    { id: "a", field: "status", enabled: false },
    { id: "b", field: "priority", enabled: true },
    { id: "c", field: "status", enabled: true },
  ];
  expect(activeGroups(groups, fields).map((f) => f.id)).toEqual([
    "priority",
    "status",
  ]);
  const moved = moveRule(groups, 2, -1);
  expect(activeGroups(moved, fields).map((f) => f.id)).toEqual([
    "status",
    "priority",
  ]);
  expect(groups[2].id).toBe("c");
  expect(moveRule(groups, 0, -1)).toEqual(groups);
});

it("scopes selection and creation defaults to the visible group and folder path", () => {
  const rows = [row("a", "open", "1"), row("b", "done", "2")];
  const state = normalizeView(
    { groups: [{ id: "status", field: "status", enabled: true }] },
    schema,
  );
  const groups = groupRecords(rows, activeGroups(state.groups, schema.fields));
  const done = groups.find((group) => group.value === "done")!;
  const opened = { ...state, path: done.path };
  expect(visibleRecords(rows, schema, opened).map((row) => row.id)).toEqual([
    "b",
  ]);
  expect(groupDefaults(rows, schema, opened)).toEqual({ status: "done" });
  expect(
    visibleRecords(rows, schema, { ...opened, collapsed: [done.id] }),
  ).toEqual([]);
  expect(
    visibleRecords(rows, schema, { ...state, mode: "short-table-folder" }),
  ).toEqual([]);
  expect(
    visibleRecords(rows, schema, { ...opened, mode: "board-folder" }).map(
      (row) => row.id,
    ),
  ).toEqual(["b"]);
});

it("uses descriptor visibility and full definition order for default columns", () => {
  const configured = {
    ...schema,
    fields: [
      { ...field("hidden"), visibility: "hidden" as const },
      { ...field("optional"), visibility: "addable" as const },
      { ...field("readonly"), visibility: "viewable" as const },
      ...Array.from({ length: 6 }, (_, index) => field("editable" + index)),
    ],
  };
  const defaults = normalizeView(undefined, configured);
  expect(defaults.columnOrder).toEqual(configured.fields.map((f) => f.id));
  expect(defaults.columns).toEqual([
    "readonly",
    ...Array.from({ length: 6 }, (_, index) => "editable" + index),
  ]);
  const custom = normalizeView(
    { columns: ["hidden"], columnOrder: ["optional", "hidden"] },
    configured,
  );
  expect(custom.columns).toEqual(["hidden"]);
  expect(custom.columnOrder?.slice(0, 2)).toEqual(["optional", "hidden"]);
});

const linked = (id: string, link: Value, status = "open") => ({
  ...row(id, status, "1"),
  collection: "test",
  data: { uid: id, link, status, title: id.toUpperCase() },
});
const linkedSchema = {
  ...schema,
  fields: [
    {
      ...field("link"),
      reference: "resources",
      referenceField: "uid" as const,
    },
    field("status"),
    field("title"),
  ],
};
const recursiveRules = [
  {
    id: "link",
    field: "link",
    enabled: true,
    mode: "recursive" as const,
    labelField: "title",
  },
];
const directIds = (nodes: ReturnType<typeof groupRecords>): string[] =>
  nodes.flatMap((n) => [
    ...(n.directRows ?? []).map((r) => r.id),
    ...directIds(n.children),
  ]);
it("nests generic references with unique labels, scoped selection and no duplicate rows", () => {
  const rows = [
    linked("a", null),
    linked("b", "a"),
    linked("c", "b"),
    linked("d", "a"),
  ];
  const state = normalizeView({ groups: recursiveRules }, linkedSchema);
  const tree = groupRecords(
    rows,
    activeGroups(state.groups, linkedSchema.fields),
  );
  expect(tree).toHaveLength(2);
  const loose = tree.find((node) => node.ungrouped)!;
  expect(loose.rows).toHaveLength(1);
  expect(loose.path).toEqual([]);
  expect(resolveGroupPath(tree, []).directRows.map((r) => r.id)).toEqual(["a"]);
  const a = tree.find((node) => node.value === "a")!,
    b = a.children[0];
  expect(a.value).toBe("a");
  expect(b.value).toBe("b");
  expect(a.rows.map((r) => r.id)).toEqual(["b", "d", "c"]);
  expect(groupLabelValues(a)).toEqual(["B", "D", "C"]);
  expect(directIds(tree).sort()).toEqual(["a", "b", "c", "d"]);
  expect(
    visibleRecords(rows, linkedSchema, { ...state, collapsed: [a.id] }).map(
      (r) => r.id,
    ),
  ).toEqual(["a"]);
  expect(
    visibleRecords(rows, linkedSchema, {
      ...state,
      path: [],
      mode: "short-table-folder",
    }).map((r) => r.id),
  ).toEqual(["a"]);
  expect(groupDefaults(rows, linkedSchema, { ...state, path: b.path })).toEqual(
    { link: "b" },
  );
});
it("composes reference ancestry with other ordered grouping rules", () => {
  const rows = [
    linked("a", null),
    linked("b", "a", "done"),
    linked("c", "b", "done"),
  ];
  const status = { id: "status", field: "status", enabled: true };
  for (const rules of [
    [...recursiveRules, status],
    [status, ...recursiveRules],
  ]) {
    const state = normalizeView({ groups: rules }, linkedSchema);
    const tree = groupRecords(rows, activeGroups(rules, linkedSchema.fields));
    expect(directIds(tree).sort()).toEqual(["a", "b", "c"]);
    expect(
      visibleRecords(rows, linkedSchema, state)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  }
});
it("keeps cycles, self references, missing references and plain values finite and visible", () => {
  const rows = [
    linked("a", "b"),
    linked("b", "a"),
    linked("c", "c"),
    linked("d", "missing"),
  ];
  const fields = activeGroups(recursiveRules, linkedSchema.fields);
  const first = groupRecords(rows, fields),
    second = groupRecords([...rows].reverse(), fields);
  expect(directIds(first).sort()).toEqual(["a", "b", "c", "d"]);
  expect(first.map((n) => n.id)).toEqual(second.map((n) => n.id));
  const plain = activeGroups(
    [{ id: "status", field: "status", mode: "recursive", enabled: true }],
    linkedSchema.fields,
  );
  expect(groupRecords(rows, plain)).toHaveLength(1);
  expect(groupRecords(rows, plain)[0].children).toEqual([]);
  const individual = activeGroups(
    [{ ...recursiveRules[0], mode: "individual" }],
    linkedSchema.fields,
  );
  expect(groupRecords(rows, individual).every((n) => !n.children.length)).toBe(
    true,
  );
});
it("deduplicates label values using typed equality without merging groups", () => {
  const fields = [
    { ...field("status"), groupLabelField: field("priority", "bigint") },
  ];
  const tree = groupRecords(
    [row("a", "open", "01"), row("b", "open", "1"), row("c", "open", "2")],
    fields,
  );
  expect(groupLabelValues(tree[0])).toEqual(["01", "2"]);
});

const displayedIds = (nodes: ReturnType<typeof groupRecords>): string[] =>
  nodes.flatMap((node) => [
    ...(node.materializedRows ?? []).map((row) => row.id),
    ...(node.directRows ?? []).map((row) => row.id),
    ...displayedIds(node.children),
  ]);
it("moves referenced items into recursive headings and retains editable parents on collapse", () => {
  const rows = [
    linked("a", null),
    linked("b", "a"),
    linked("c", "b"),
    linked("d", "a"),
  ];
  const groups = [
    { ...recursiveRules[0], labelField: "link", materialize: true },
  ];
  const state = normalizeView({ groups }, linkedSchema);
  const tree = groupRecords(rows, activeGroups(groups, linkedSchema.fields));
  const a = tree[0],
    b = a.children[0];
  expect(a.materializedRows?.map((row) => row.id)).toEqual(["a"]);
  expect(a.directRows?.map((row) => row.id)).toEqual(["d"]);
  expect(b.materializedRows?.map((row) => row.id)).toEqual(["b"]);
  expect(b.directRows?.map((row) => row.id)).toEqual(["c"]);
  expect(displayedIds(tree).sort()).toEqual(["a", "b", "c", "d"]);
  expect(
    visibleRecords(rows, linkedSchema, { ...state, collapsed: [a.id] }).map(
      (row) => row.id,
    ),
  ).toEqual(["a"]);
  expect(
    visibleRecords(rows, linkedSchema, { ...state, path: b.path }).map(
      (row) => row.id,
    ),
  ).toEqual(["a", "b", "c"]);
  expect(
    visibleRecords(rows, linkedSchema, {
      ...state,
      path: a.path,
      mode: "short-table-folder",
    })
      .map((row) => row.id)
      .sort(),
  ).toEqual(["a", "b", "d"]);
  expect(groupDefaults(rows, linkedSchema, { ...state, path: b.path })).toEqual(
    { link: "b" },
  );
  expect(normalizeView(state, linkedSchema).groups[0].materialize).toBe(true);
});
it("materializes each item once with repeated targets, multiple rules, arrays and cycles", () => {
  const rows = [
    linked("a", "b"),
    linked("b", "a", "done"),
    linked("c", "c"),
    linked("d", "missing", "done"),
    linked("e", "a"),
  ];
  const reference = {
    ...recursiveRules[0],
    labelField: "link",
    materialize: true,
  };
  const status = { id: "status", field: "status", enabled: true };
  for (const mode of ["individual", "recursive"] as const)
    for (const groups of [
      [{ ...reference, mode }, status],
      [status, { ...reference, mode }],
    ]) {
      const state = normalizeView({ groups }, linkedSchema);
      const tree = groupRecords(
        rows,
        activeGroups(groups, linkedSchema.fields),
      );
      expect(displayedIds(tree).sort()).toEqual(["a", "b", "c", "d", "e"]);
      expect(
        visibleRecords(rows, linkedSchema, state)
          .map((row) => row.id)
          .sort(),
      ).toEqual(["a", "b", "c", "d", "e"]);
    }
  const fields = activeGroups([reference], linkedSchema.fields).map((f) => ({
    ...f,
    array: true,
  }));
  const arrayRows = [
    linked("a", []),
    linked("b", []),
    linked("c", ["a", "b"]),
    linked("d", ["a"]),
  ];
  expect(displayedIds(groupRecords(arrayRows, fields)).sort()).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
});
it("does not materialize filtered, ambiguous or out-of-scope references", () => {
  const reference = {
    ...recursiveRules[0],
    labelField: "link",
    materialize: true,
  };
  const fields = activeGroups([reference], linkedSchema.fields);
  const rows = [linked("b", "a")];
  expect(displayedIds(groupRecords(rows, fields))).toEqual(["b"]);
  const ambiguous = [
    linked("a", null),
    { ...linked("other", null), data: { uid: "a", link: null } },
    linked("b", "a"),
  ];
  expect(
    groupRecords(ambiguous, fields).flatMap((n) => n.materializedRows ?? []),
  ).toEqual([]);
  const scoped = fields.map((f) => ({
    ...f,
    referenceTable: "another-table",
    groupMaterializeField: { ...f, referenceTable: "another-table" },
  }));
  expect(
    groupRecords([linked("a", null), linked("b", "a")], scoped).flatMap(
      (n) => n.materializedRows ?? [],
    ),
  ).toEqual([]);
});

it("materializes the selected reference label field without depending on the grouping field type", () => {
  const rows = [
    linked("a", null),
    linked("b", "a", "done"),
    linked("c", "a", "done"),
  ];
  const groups = [
    {
      id: "s",
      field: "status",
      enabled: true,
      labelField: "link",
      materialize: true,
    },
  ];
  const tree = groupRecords(rows, activeGroups(groups, linkedSchema.fields));
  expect(tree).toHaveLength(1);
  expect(tree[0].value).toBe("done");
  expect(tree[0].materializedRows?.map((row) => row.id)).toEqual(["a"]);
  expect(displayedIds(tree).sort()).toEqual(["a", "b", "c"]);
  const ordinary = groupRecords(
    rows,
    activeGroups([{ ...groups[0], labelField: "title" }], linkedSchema.fields),
  );
  expect(ordinary.flatMap((node) => node.materializedRows ?? [])).toEqual([]);
  expect(displayedIds(ordinary).sort()).toEqual(["a", "b", "c"]);
});

it("recurses through a materialized parent label instead of lumping unrelated notes buckets together", () => {
  const schema = {
    ...linkedSchema,
    fields: [
      ...linkedSchema.fields.map((field) =>
        field.id === "link"
          ? { ...field, referenceField: "id" as const }
          : field,
      ),
      field("body"),
    ],
  };
  const rows = [
    linked("root", null),
    linked("child", "root"),
    linked("leaf", "child"),
    linked("other", null),
    linked("other-child", "other"),
  ].map((row) => ({
    ...row,
    data: { ...row.data, uid: "uid-" + row.id, body: null },
  }));
  const saved = {
    groups: [
      {
        id: "notes",
        field: "body",
        labelField: "link",
        materialize: true,
        mode: "recursive" as const,
        enabled: true,
      },
    ],
  };
  const state = normalizeView(saved, schema);
  expect(state.groups[0].field).toBe("link");
  // Consumers also pass raw grouping rules directly to activeGroups.
  const tree = groupRecords(rows, activeGroups(saved.groups, schema.fields));
  const root = resolveGroupPath(tree, []);
  expect(root.children.map((node) => node.value).sort()).toEqual([
    "other",
    "root",
  ]);
  const branch = root.children.find((node) => node.value === "root")!;
  expect(branch.materializedRows?.map((row) => row.id)).toEqual(["root"]);
  expect(branch.children[0].materializedRows?.map((row) => row.id)).toEqual([
    "child",
  ]);
  expect(branch.children[0].directRows?.map((row) => row.id)).toEqual(["leaf"]);
  expect(displayedIds(tree).sort()).toEqual(rows.map((row) => row.id).sort());
  expect(
    visibleRecords(rows, schema, { ...state, collapsed: [branch.id] }).map(
      (row) => row.id,
    ),
  ).toEqual(["root", "other", "other-child"]);
  expect(
    groupDefaults(rows, schema, { ...state, path: branch.children[0].path }),
  ).toEqual({ link: "child" });
});

it("keeps unrelated parentless trees separate with no synthetic no-parent ancestor", () => {
  const rows = [
    linked("a", null),
    linked("b", "a"),
    linked("c", "b"),
    linked("x", null),
    linked("y", "x"),
    linked("loose", null),
    linked("empty", ""),
  ];
  for (const materialize of [false, true]) {
    const groups = [{ ...recursiveRules[0], labelField: "link", materialize }];
    const state = normalizeView({ groups }, linkedSchema);
    const tree = groupRecords(rows, activeGroups(groups, linkedSchema.fields));
    const root = resolveGroupPath(tree, []);
    expect(root.children.map((node) => node.value)).toEqual(["a", "x"]);
    expect(root.children.every((node) => node.path.length === 1)).toBe(true);
    expect(root.directRows.map((row) => row.id).sort()).toEqual(
      materialize ? ["empty", "loose"] : ["a", "empty", "loose", "x"],
    );
    const a = root.children[0];
    expect(groupLabelValues(a)).toEqual(["a"]);
    expect(groupLabelValues(root.children[1])).toEqual(["x"]);
    expect(a.children[0].value).toBe("b");
    expect(groupLabelValues(a.children[0])).toEqual(["b"]);
    expect(a.children[0].path).toHaveLength(2);
    expect(
      resolveGroupPath(tree, a.path).ancestors.map((n) => n.value),
    ).toEqual(["a"]);
    expect(
      visibleRecords(rows, linkedSchema, { ...state, path: a.path })
        .map((row) => row.id)
        .sort(),
    ).toEqual(materialize ? ["a", "b", "c"] : ["b", "c"]);
    expect(
      visibleRecords(rows, linkedSchema, state)
        .map((row) => row.id)
        .sort(),
    ).toEqual(rows.map((row) => row.id).sort());
    expect(
      visibleRecords(rows, linkedSchema, {
        ...state,
        mode: "short-table-folder",
      })
        .map((row) => row.id)
        .sort(),
    ).toEqual(["a", "empty", "loose", "x"]);
    expect(groupDefaults(rows, linkedSchema, state)).toEqual({});
    // A previously saved synthetic-root breadcrumb must not trap the view.
    expect(
      resolveGroupPath(tree, [{ field: "link", key: "null" }]).ancestors,
    ).toEqual([]);
  }
  const tree = groupRecords(
    rows,
    activeGroups(
      [{ ...recursiveRules[0], mode: "individual" }],
      linkedSchema.fields,
    ),
  );
  expect(tree.some((node) => node.value === null && !node.ungrouped)).toBe(
    true,
  );
});

it("keeps an entirely parentless view navigable and applies subsequent groups", () => {
  const rows = [linked("a", null), linked("b", ""), linked("c", null, "done")];
  const state = normalizeView({ groups: recursiveRules }, linkedSchema);
  const tree = groupRecords(
    rows,
    activeGroups(state.groups, linkedSchema.fields),
  );
  const root = resolveGroupPath(tree, []);
  expect(root.children).toEqual([]);
  expect(root.directRows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect(
    visibleRecords(rows, linkedSchema, {
      ...state,
      mode: "short-table-folder",
      collapsed: tree.map((node) => node.id),
    }).map((row) => row.id),
  ).toEqual(["a", "b", "c"]);

  const groups = [
    ...recursiveRules,
    { id: "status", field: "status", enabled: true },
  ];
  const grouped = groupRecords(rows, activeGroups(groups, linkedSchema.fields));
  const folders = resolveGroupPath(grouped, []).children;
  expect(folders).toHaveLength(2);
  expect(
    folders.every(
      (node) => node.path.length === 1 && node.field.id === "status",
    ),
  ).toBe(true);
  const open = folders.find((node) => node.value === "open")!;
  expect(
    resolveGroupPath(grouped, open.path).directRows.map((row) => row.id),
  ).toEqual(["a", "b"]);
  expect(
    groupDefaults(rows, linkedSchema, { ...state, groups, path: open.path }),
  ).toEqual({ status: "open" });
});

it("toggles complete grouping depths without changing other levels or branches", () => {
  const rows = [
    linked("a", null),
    linked("b", "a"),
    linked("c", "b"),
    linked("x", null),
    linked("y", "x"),
  ];
  const state = normalizeView({ groups: recursiveRules }, linkedSchema);
  const tree = groupRecords(
    rows,
    activeGroups(state.groups, linkedSchema.fields),
  );
  const levels = groupLevels(tree);
  expect(state.collapsed).toEqual([]);
  expect(
    levels.map((level) => [
      level.depth,
      level.nodes.map((node) => node.value).sort(),
    ]),
  ).toEqual([
    [1, ["a", "x"]],
    [2, ["b"]],
  ]);
  expect(
    levels.flatMap((level) => level.nodes).some((node) => node.ungrouped),
  ).toBe(false);
  const first = levels[0].nodes,
    second = levels[1].nodes;
  const mixed = ["outside", first[0].id, second[0].id];
  const closed = toggleGroupLevel(mixed, first);
  expect(first.every((node) => closed.includes(node.id))).toBe(true);
  expect(closed).toContain(second[0].id);
  expect(new Set(closed).size).toBe(closed.length);
  expect(toggleGroupLevel(closed, first).sort()).toEqual(
    ["outside", second[0].id].sort(),
  );
  expect(
    visibleRecords(rows, linkedSchema, { ...state, collapsed: closed })
      .map((row) => row.id)
      .sort(),
  ).toEqual(["a", "x"]);
  const a = first.find((node) => node.value === "a")!;
  const scoped = groupLevels(tree, a.path);
  expect(
    scoped
      .flatMap((level) => level.nodes)
      .map((node) => node.value)
      .sort(),
  ).toEqual(["a", "b"]);
  expect(
    groupLevels(
      groupRecords(
        [linked("a", null)],
        activeGroups(state.groups, linkedSchema.fields),
      ),
    ),
  ).toEqual([]);
  expect(groupLevels([])).toEqual([]);
});
