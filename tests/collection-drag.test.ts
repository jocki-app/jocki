import { expect, it } from "vitest";
import { LexoRank } from "lexorank";
import {
  field,
  fieldTypeId,
  fieldTemplate,
  fieldTypes,
  queryRecords,
  type RecordSchema,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import {
  normalizeView,
  groupRecords,
  activeGroups,
  resolveGroupPath,
  visibleRecords,
} from "../packages/ui/collection-view-model";
import {
  planRowMove,
  planRowDeletion,
  rowGroupPaths,
} from "../packages/ui/collection-drag";
const schema: RecordSchema = {
  id: "nodes",
  name: "Nodes",
  pluginId: "test",
  version: 1,
  fields: [
    field("link", "Link", "text", {
      reference: "nodes",
      referenceField: "uid",
    }),
    field("state", "State"),
    field("rank", "Order", "text", fieldTypes.sorting.definition),
  ],
};
const row = (
  id: string,
  link: string | null = null,
  state = "open",
  rank?: string,
) =>
  ({
    id,
    collection: "nodes",
    data: { uid: `uid-${id}`, link, state, ...(rank ? { rank } : {}) },
  }) as unknown as ResourceRecord;
const groups = [
  {
    id: "link",
    field: "link",
    enabled: true,
    mode: "recursive" as const,
    materialize: true,
  },
];
const sorted = (direction: "asc" | "desc" = "asc") =>
  normalizeView(
    { query: { sorts: [{ field: "rank", enabled: true, direction }] } },
    schema,
  );
const path = (
  rows: ResourceRecord[],
  state: ReturnType<typeof normalizeView>,
  id: string,
) => {
  const pending = groupRecords(rows, activeGroups(state.groups, schema.fields));
  while (pending.length) {
    const node = pending.pop()!;
    if (node.value === id) return node.path;
    pending.push(...node.children);
  }
  throw Error("Missing group");
};
const apply = (rows: ResourceRecord[], moves: ReturnType<typeof planRowMove>) =>
  rows.map((row) => ({
    ...row,
    data: {
      ...row.data,
      ...moves.find((move) => move.row.id === row.id)?.patch,
    },
  }));
it("defines Sorting as a portable ordinary text column", () => {
  const rank = schema.fields[2];
  expect(fieldTypeId(rank)).toBe("sorting");
  expect(fieldTemplate(rank)).toMatchObject({
    pgType: "text",
    control: "sorting",
    storage: "custom",
  });
});
it("moves to the deepest recursive group using reference identifiers and keeps descendants attached", () => {
  const rows = [
    row("a"),
    row("b", "uid-a"),
    row("c", "uid-b"),
    row("x"),
    row("y", "uid-x"),
  ];
  const state = normalizeView({ groups }, schema);
  const moves = planRowMove(rows, schema, state, {
    rowId: "x",
    path: path(rows, state, "uid-b"),
  });
  expect(moves.map((move) => [move.row.id, move.patch])).toEqual([
    ["x", { link: "uid-b" }],
  ]);
  const changed = apply(rows, moves);
  expect(rowGroupPaths(changed, schema, state).get("y")).toHaveLength(3);
  expect(
    planRowMove(rows, schema, state, { rowId: "c", path: [] })[0].patch,
  ).toEqual({ link: null });
  expect(() =>
    planRowMove(rows, schema, state, {
      rowId: "a",
      path: path(rows, state, "uid-b"),
    }),
  ).toThrow(/descendants/);
});
it("updates all selected subgroup fields and rejects stale or read-only destinations", () => {
  const rows = [row("a"), row("b", "uid-a", "done"), row("x")];
  const state = normalizeView(
    { groups: [...groups, { id: "state", field: "state", enabled: true }] },
    schema,
  );
  const parent = resolveGroupPath(
    groupRecords(rows, activeGroups(state.groups, schema.fields)),
    path(rows, state, "uid-a"),
  );
  const done = parent.children.find((node) => node.value === "done")!;
  expect(
    planRowMove(rows, schema, state, { rowId: "x", path: done.path })[0].patch,
  ).toEqual({ link: "uid-a", state: "done" });
  expect(() =>
    planRowMove(rows, schema, state, {
      rowId: "x",
      path: [{ field: "link", key: '"gone"' }],
    }),
  ).toThrow(/no longer/);
  expect(() =>
    planRowMove(
      rows,
      {
        ...schema,
        fields: schema.fields.map((f) =>
          f.id === "state" ? { ...f, visibility: "viewable" } : f,
        ),
      },
      state,
      { rowId: "x", path: done.path },
    ),
  ).toThrow(/read-only/);
});
it("initializes blank ranks, persists ordinary values and reorders in either direction", () => {
  for (const direction of ["asc", "desc"] as const) {
    const state = sorted(direction);
    let rows = [row("a"), row("b"), row("c")];
    const move = planRowMove(rows, schema, state, {
      rowId: "c",
      path: [],
      anchorId: "b",
      position: "before",
    });
    expect(move).toHaveLength(3);
    expect(move.at(-1)?.row.id).toBe("c");
    rows = queryRecords(apply(rows, move), schema, state.query);
    expect(rows.map((row) => row.id)).toEqual(["a", "c", "b"]);
    rows.forEach((row) =>
      expect(LexoRank.parse(String(row.data.rank)).toString()).toBe(
        row.data.rank,
      ),
    );
    const second = planRowMove(rows, schema, state, {
      rowId: "b",
      path: [],
      anchorId: "a",
      position: "before",
    });
    expect(second).toHaveLength(1);
    rows = queryRecords(apply(rows, second), schema, state.query);
    expect(rows.map((row) => row.id)).toEqual(["b", "a", "c"]);
    const last = planRowMove(rows, schema, state, {
      rowId: "b",
      path: [],
      anchorId: "c",
      position: "after",
    });
    expect(
      queryRecords(apply(rows, last), schema, state.query).map((row) => row.id),
    ).toEqual(["a", "c", "b"]);
  }
});
it("repairs duplicate and invalid bounds without losing rows", () => {
  for (const value of [LexoRank.middle().toString(), "invalid"]) {
    const rows = [
      row("a", null, "open", value),
      row("b", null, "open", value),
      row("c"),
    ];
    const state = sorted();
    const changed = apply(
      rows,
      planRowMove(rows, schema, state, {
        rowId: "c",
        path: [],
        anchorId: "b",
        position: "before",
      }),
    );
    expect(
      queryRecords(changed, schema, state.query).map((row) => row.id),
    ).toEqual(["a", "c", "b"]);
  }
});
it("combines grouping and ranking, and orders materialized parents as siblings", () => {
  const rows = [
    row("a"),
    row("b", "uid-a"),
    row("c", "uid-b"),
    row("x"),
    row("y", "uid-x"),
  ];
  const state = { ...sorted(), groups };
  const moves = planRowMove(rows, schema, state, {
    rowId: "y",
    path: path(rows, state, "uid-b"),
    anchorId: "c",
    position: "before",
  });
  expect(moves.find((move) => move.row.id === "y")?.patch.link).toBe("uid-b");
  expect(moves.map((move) => move.row.id).sort()).toEqual(["c", "y"]);
  const roots = planRowMove(rows, schema, state, {
    rowId: "x",
    path: [],
    anchorId: "a",
    position: "before",
  });
  expect(roots.every((move) => move.patch.link === undefined)).toBe(true);
  expect(
    queryRecords(apply(rows, roots), schema, state.query)
      .filter((row) => row.data.link === null)
      .map((row) => row.id),
  ).toEqual(["x", "a"]);
});
it("respects prior sort keys and refuses cycles through filtered-out ancestors", () => {
  const rows = [
    row("a"),
    row("b", "uid-a"),
    row("c", "uid-b", "done"),
    row("d", "uid-c"),
  ];
  const state = normalizeView({ groups }, schema);
  expect(() =>
    planRowMove(
      [rows[0], rows[2], rows[3]],
      schema,
      state,
      { rowId: "a", path: path([rows[0], rows[2], rows[3]], state, "uid-c") },
      rows,
    ),
  ).toThrow(/descendants/);
  const multi = {
    ...sorted(),
    query: {
      sorts: [
        { field: "state", direction: "asc" as const, enabled: true },
        ...sorted().query.sorts!,
      ],
    },
  };
  expect(() =>
    planRowMove(rows, schema, multi, {
      rowId: "a",
      path: [],
      anchorId: "c",
      position: "after",
    }),
  ).toThrow(/Sorting column first/);
});

it("drops onto any record to create a group, including a former leaf and a materialized parent", () => {
  for (const mode of ["individual", "recursive"] as const) {
    const rows = [
      row("a"),
      row("b", "uid-a"),
      row("leaf"),
      row("x", null, "done"),
    ];
    const state = normalizeView(
      {
        groups: [
          { ...groups[0], mode },
          { id: "state", field: "state", enabled: true },
        ],
      },
      schema,
    );
    for (const targetId of ["a", "leaf", "b"]) {
      expect(
        planRowMove(rows, schema, state, {
          rowId: "x",
          targetId,
          path: [],
        }).map((move) => [move.row.id, move.patch]),
      ).toEqual([["x", { link: `uid-${targetId}`, state: "open" }]]);
    }
    expect(
      planRowMove(rows, schema, state, {
        rowId: "x",
        anchorId: "b",
        position: "after",
        path: rowGroupPaths(rows, schema, state).get("b")!,
      })[0].patch,
    ).toEqual({ link: "uid-a", state: "open" });
  }
  const rows = [row("a"), row("b", "uid-a"), row("c", "uid-b")];
  expect(() =>
    planRowMove(rows, schema, normalizeView({ groups }, schema), {
      rowId: "a",
      targetId: "c",
      path: [],
    }),
  ).toThrow(/descendants/);
  const category = normalizeView(
    { groups: [{ id: "state", field: "state", enabled: true }] },
    schema,
  );
  expect(
    planRowMove([row("a"), row("b", null, "done")], schema, category, {
      rowId: "a",
      targetId: "b",
      path: [],
    })[0].patch,
  ).toEqual({ state: "done" });
});

it("orders parent branches and leaves together while changing only the moved parent's rank", () => {
  const rank = LexoRank.middle();
  for (const direction of ["asc", "desc"] as const) {
    const state = { ...sorted(direction), groups };
    const rows = queryRecords(
      [
        row("a", null, "open", rank.toString()),
        row("leaf", null, "open", rank.genNext().toString()),
        row(
          "b",
          null,
          "open",
          (direction === "asc"
            ? rank.genNext().genNext()
            : rank.genPrev()
          ).toString(),
        ),
        row("a-child", "uid-a", "open", rank.toString()),
        row("b-child", "uid-b", "open", rank.toString()),
        row("grandchild", "uid-b-child", "open", rank.toString()),
      ],
      schema,
      state.query,
    );
    const moves = planRowMove(rows, schema, state, {
      rowId: "b",
      anchorId: "leaf",
      position: "before",
      path: [],
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].row.id).toBe("b");
    expect(Object.keys(moves[0].patch)).toEqual(["rank"]);
    const changed = queryRecords(apply(rows, moves), schema, state.query);
    const displayed = visibleRecords(changed, schema, state).map(
      (row) => row.id,
    );
    expect(
      displayed.slice(displayed.indexOf("b"), displayed.indexOf("leaf") + 1),
    ).toEqual(["b", "b-child", "grandchild", "leaf"]);
    expect(changed.find((row) => row.id === "b-child")?.data.rank).toBe(
      rank.toString(),
    );
    // Reparenting a branch changes only its own membership and rank.
    const into = planRowMove(changed, schema, state, {
      rowId: "b",
      targetId: "a-child",
      path: [],
    });
    expect(into).toHaveLength(1);
    expect(into[0].patch.link).toBe("uid-a-child");
  }
});

it("repairs only duplicate bounds near insertion without rewriting other siblings", () => {
  const rank = LexoRank.middle(),
    next = rank.genNext(),
    end = next.genNext();
  const rows = [
    row("a", null, "open", rank.toString()),
    row("b", null, "open", next.toString()),
    row("c", null, "open", next.toString()),
    row("d", null, "open", end.toString()),
    row("moving"),
  ];
  const moves = planRowMove(rows, schema, sorted(), {
    rowId: "moving",
    anchorId: "c",
    position: "before",
    path: [],
  });
  expect(moves.map((move) => move.row.id).sort()).toEqual(["c", "moving"]);
  expect(
    queryRecords(apply(rows, moves), schema, sorted().query).map(
      (row) => row.id,
    ),
  ).toEqual(["a", "b", "moving", "c", "d"]);
});

it("deletes reference descendants from the full table across filters, collapse, and overlapping selection", () => {
  const rows = [
    row("root"),
    row("child", "uid-root", "done"),
    row("grandchild", "uid-child"),
    row("unrelated"),
  ];
  const state = normalizeView(
    {
      groups,
      collapsed: ["anything"],
      query: {
        filters: [
          {
            id: "filter",
            field: "state",
            operator: "eq",
            link: "and",
            value: "open",
            enabled: true,
          },
        ],
      },
    },
    schema,
  );
  expect(
    planRowDeletion(rows, schema, state, ["root", "child"]).map(
      (row) => row.id,
    ),
  ).toEqual(["root", "child", "grandchild"]);
  expect(
    planRowDeletion(rows, schema, normalizeView({}, schema), ["root"]).map(
      (row) => row.id,
    ),
  ).toEqual(["root"]);
  const cycle = [row("a", "uid-b"), row("b", "uid-a"), row("other")];
  expect(
    planRowDeletion(cycle, schema, state, ["a"]).map((row) => row.id),
  ).toEqual(["a", "b"]);
  const duplicate = {
    ...row("copy"),
    data: { uid: "uid-root" },
  } as ResourceRecord;
  expect(
    planRowDeletion([...rows, duplicate], schema, state, ["root"]).map(
      (row) => row.id,
    ),
  ).toEqual(["root"]);
});

it("places materialized branches in the same later-rule subgroup as leaf siblings", () => {
  const rank = LexoRank.middle();
  const state = {
    ...sorted(),
    groups: [...groups, { id: "state", field: "state", enabled: true }],
  };
  const rows = queryRecords(
    [
      row("root", null, "open", rank.toString()),
      row("branch", "uid-root", "open", rank.toString()),
      row("leaf", "uid-root", "open", rank.genNext().toString()),
      row("grandchild", "uid-branch", "done", rank.toString()),
    ],
    schema,
    state.query,
  );
  const moves = planRowMove(rows, schema, state, {
    rowId: "branch",
    anchorId: "leaf",
    position: "after",
    path: rowGroupPaths(rows, schema, state).get("leaf")!,
  });
  expect(moves).toHaveLength(1);
  expect(moves[0].row.id).toBe("branch");
  const changed = queryRecords(apply(rows, moves), schema, state.query);
  expect(visibleRecords(changed, schema, state).map((row) => row.id)).toEqual([
    "root",
    "leaf",
    "branch",
    "grandchild",
  ]);
});

it("repairs exhausted boundary ranks without touching distant siblings", () => {
  for (const direction of ["asc", "desc"] as const) {
    const state = sorted(direction);
    const bound = direction === "asc" ? LexoRank.min() : LexoRank.max();
    const rows = queryRecords(
      [
        row("bound", null, "open", bound.toString()),
        row("distant", null, "open", LexoRank.middle().toString()),
        row("moving"),
      ],
      schema,
      state.query,
    );
    const moves = planRowMove(rows, schema, state, {
      rowId: "moving",
      anchorId: "bound",
      position: "before",
      path: [],
    });
    expect(moves.some((move) => move.row.id === "distant")).toBe(false);
    expect(
      queryRecords(apply(rows, moves), schema, state.query).map(
        (row) => row.id,
      ),
    ).toEqual(["moving", "bound", "distant"]);
  }
});
