import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { GripVertical } from "lucide-react";
import type { RecordSchema } from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { Button } from "./primitives/button";
import { notify } from "./notifications";
import {
  activeGroups,
  groupRecords,
  groupKey,
  type CollectionViewState,
  type GroupSegment,
} from "./collection-view-model";
import {
  rowGroupPaths,
  sortingRule,
  rowDropReference,
  referenceIdentity,
  type RowDrop,
} from "./collection-drag";

type DragTarget = RowDrop & { highlightPath?: GroupSegment[] };

export function useCollectionDrag({
  rows,
  schema,
  state,
  writable,
  onMove,
  color,
}: {
  rows: ResourceRecord[];
  schema: RecordSchema;
  state: CollectionViewState;
  writable?: (row: ResourceRecord) => boolean;
  onMove?: (drop: RowDrop) => Promise<void>;
  color: (path: GroupSegment[]) => string;
}) {
  const enabled =
    !!onMove &&
    (!!activeGroups(state.groups, schema.fields).length ||
      !!sortingRule(schema, state));
  const sorted = !!sortingRule(schema, state);
  const groupFields = useMemo(
    () => activeGroups(state.groups, schema.fields),
    [state.groups, schema.fields],
  );
  const paths = useMemo(
    () => rowGroupPaths(rows, schema, state),
    [rows, schema, state.groups],
  );
  const { rowTargets, memberships } = useMemo(() => {
    const tree = groupRecords(rows, groupFields),
      nodes = [...tree];
    for (let i = 0; i < nodes.length; i++) nodes.push(...nodes[i].children);
    const memberships = new Map<string, GroupSegment[]>();
    const ownedPaths = new Map<string, GroupSegment[]>();
    const groupPaths = new Map<string, GroupSegment[]>();
    for (const node of nodes) {
      node.directRows?.forEach((row) => memberships.set(row.id, node.path));
      node.materializedRows?.forEach((row) => {
        memberships.set(row.id, node.path.slice(0, -1));
        ownedPaths.set(JSON.stringify([node.field.id, row.id]), node.path);
      });
      const key = JSON.stringify([
        node.field.id,
        groupKey(node.field, node.value),
      ]);
      if (!groupPaths.has(key)) groupPaths.set(key, node.path);
    }
    const rowTargets = new Map(
      rows.map((row) => {
        const natural = paths.get(row.id) ?? [];
        const field = rowDropReference(row, groupFields);
        if (!field) return [row.id, memberships.get(row.id) ?? natural];
        const key = groupKey(field, referenceIdentity(row, field));
        const owned =
          ownedPaths.get(JSON.stringify([field.id, row.id])) ??
          groupPaths.get(JSON.stringify([field.id, key]));
        const level = groupFields.indexOf(field);
        const parent = natural.filter((segment) => {
          const index = groupFields.findIndex((f) => f.id === segment.field);
          return (
            index < level ||
            (index === level && field.groupMode === "recursive")
          );
        });
        return [row.id, owned ?? [...parent, { field: field.id, key }]];
      }),
    );
    return { rowTargets, memberships };
  }, [rows, groupFields, paths]);
  const dragging = useRef<string | null>(null);
  const [target, setTarget] = useState<DragTarget | null>(null);
  const finish = () => {
    dragging.current = null;
    setTarget(null);
  };
  const handle = (row: ResourceRecord) =>
    enabled && (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Drag entry"
        title="Drag to a group or between entries"
        className="cursor-grab active:cursor-grabbing touch-none"
        disabled={!(writable?.(row) ?? false)}
        draggable={writable?.(row) ?? false}
        onDragStart={(event) => {
          if (!writable?.(row)) {
            event.preventDefault();
            return;
          }
          dragging.current = row.id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.id);
          event.stopPropagation();
        }}
        onDragEnd={finish}
      >
        <GripVertical />
      </Button>
    );
  const destination = (
    event: DragEvent<HTMLElement>,
    path: GroupSegment[],
    row?: ResourceRecord,
  ): DragTarget | null => {
    if (!enabled || !dragging.current || row?.id === dragging.current)
      return null;
    if (!row) return { rowId: dragging.current, path };
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    if (groupFields.length && fraction >= 0.25 && fraction <= 0.75)
      return {
        rowId: dragging.current,
        path: rowTargets.get(row.id) ?? [],
        targetId: row.id,
      };
    return {
      rowId: dragging.current,
      path: paths.get(row.id) ?? [],
      highlightPath: memberships.get(row.id) ?? path,
      anchorId: row.id,
      position: fraction < 0.5 ? "before" : "after",
    };
  };
  const surface = (path: GroupSegment[], row?: ResourceRecord) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      const next = destination(event, path, row);
      if (!next) {
        setTarget(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setTarget((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      const next = destination(event, path, row);
      if (!next) return;
      event.preventDefault();
      finish();
      void onMove?.(next).catch((error) =>
        notify.error(error instanceof Error ? error.message : String(error)),
      );
    },
  });
  const highlightPath = target?.highlightPath ?? target?.path ?? [];
  const highlighted = (path: GroupSegment[], id?: string) =>
    !!target &&
    ((!!id && target.targetId === id) ||
      (highlightPath.length > 0 &&
        highlightPath.every(
          (segment, index) =>
            segment.field === path[index]?.field &&
            segment.key === path[index]?.key,
        )));
  const style = (path: GroupSegment[], id?: string): CSSProperties => ({
    ...(highlighted(path, id)
      ? {
          backgroundColor: `color-mix(in srgb, ${color(highlightPath)} 18%, transparent)`,
        }
      : {}),
    ...(sorted && target && target.anchorId === id && id
      ? {
          boxShadow: `inset 0 ${target.position === "before" ? "3" : "-3"}px 0 0 ${highlightPath.length ? color(highlightPath) : "var(--foreground)"}`,
        }
      : {}),
  });
  return {
    handle,
    surface,
    style,
    highlighted,
    position: (id: string) =>
      target?.anchorId === id ? target.position : undefined,
    finish,
    clearTarget: () => setTarget(null),
  };
}
