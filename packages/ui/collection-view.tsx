import { CalendarView } from "./calendar-view";
import { calendarFields } from "./calendar-model";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Folder,
} from "lucide-react";
import type {
  Field,
  RecordSchema,
  Value,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./primitives/table";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./primitives/breadcrumb";
import { Button } from "./primitives/button";
import { Card, CardContent, CardFooter } from "./primitives/card";
import { displayValue } from "./fields";
import { MarkdownInput } from "./markdown-input";
import { cn } from "./utils";
import { useCollectionDrag } from "./collection-drag-view";
import type { RowDrop } from "./collection-drag";
import {
  activeGroups,
  orderedGroupEntries,
  groupRecords,
  groupLabelValues,
  groupLevels,
  toggleGroupLevel,
  resolveGroupPath,
  type CollectionViewState,
  type GroupNode,
  type GroupSegment,
} from "./collection-view-model";

const groupIndent = 16;
const groupStripeWidth = 3;
const groupToggleSize = 24;
const groupStep = groupIndent + groupStripeWidth;
const groupToggleInset = (depth: number) =>
  8 + depth * groupStripeWidth + (depth - 1) * groupIndent;

export interface CellContext {
  row: ResourceRecord;
  field: Field;
  value: Value | undefined;
  defaultContent: ReactNode;
  writable: boolean;
  update: (patch: Record<string, Value>) => Promise<void>;
}
export interface ColumnOptions {
  header?: ReactNode;
  className?: string;
  width?: number | string;
}
export interface CollectionViewProps {
  schema: RecordSchema;
  rows: ResourceRecord[];
  state: CollectionViewState;
  onChange: (patch: Partial<CollectionViewState>) => void;
  onOpen?: (row: ResourceRecord) => void;
  headerActions?: ReactNode;
  showRootLabel?: boolean;
  showCount?: boolean;
  createRow?: { cell: (field: Field) => ReactNode; actions: ReactNode };
  rowDetails?: (row: ResourceRecord) => ReactNode;

  renderActions?: (row: ResourceRecord, dragHandle?: ReactNode) => ReactNode;
  onMove?: (drop: RowDrop) => Promise<void>;
  renderCell?: (context: CellContext) => ReactNode;
  renderCard?: (row: ResourceRecord, defaultContent: ReactNode) => ReactNode;
  columnOptions?: Record<string, ColumnOptions>;
  writable?: (row: ResourceRecord) => boolean;
  onUpdate?: (
    row: ResourceRecord,
    patch: Record<string, Value>,
  ) => Promise<void>;
}
/** Pure shared presentation. Storage/permissions/editing stay in the host adapter. */
export function CollectionView({
  schema,
  rows,
  state,
  onChange,
  onOpen,
  headerActions,
  showRootLabel = true,
  showCount = true,
  createRow,
  rowDetails,
  renderActions,
  onMove,
  renderCell,
  renderCard,
  columnOptions,
  writable,
  onUpdate,
}: CollectionViewProps) {
  const groupFields = useMemo(
    () => activeGroups(state.groups, schema.fields),
    [state.groups, schema.fields],
  );
  const tree = useMemo(
    () => groupRecords(rows, groupFields),
    [rows, groupFields],
  );
  const rowOrder = useMemo(
    () => new Map(rows.map((row, index) => [row.id, index])),
    [rows],
  );
  const rowInset = useMemo(() => {
    let depth = 0;
    const pending = [...tree];
    while (pending.length) {
      const node = pending.pop()!;
      depth = Math.max(depth, node.path.length);
      pending.push(...node.children);
    }
    return 8 + depth * 3;
  }, [tree]);
  const { ancestors, children, directRows } = resolveGroupPath(
    tree,
    state.path,
  );
  const scopedRows = tree.length ? directRows : rows;
  const levels = useMemo(
    () => groupLevels(tree, state.path),
    [tree, state.path],
  );
  const current = ancestors.at(-1);
  const entries = current?.rows ?? rows;
  const fields = state.columns.flatMap(
    (id) => schema.fields.find((f) => f.id === id) ?? [],
  );
  const collapsed = new Set(state.collapsed);
  const folder = state.mode.endsWith("-folder"),
    board = state.mode.startsWith("board"),
    short = state.mode.startsWith("short") || state.mode === "list";
  const go = (path: GroupSegment[]) =>
    onChange({
      path,
      collapsed: state.collapsed.filter(
        (id) =>
          !path.some((_, i) => id === JSON.stringify(path.slice(0, i + 1))),
      ),
    });
  const toggle = (id: string) =>
    onChange({
      collapsed: collapsed.has(id)
        ? state.collapsed.filter((key) => key !== id)
        : [...state.collapsed, id],
    });
  const [colorOffset] = useState(() => Math.random() * 360);
  const palette = useRef(new Map<string, string>());
  const groupColor = (path: GroupSegment[]) => {
    const id = JSON.stringify(path);
    if (!palette.current.has(id))
      palette.current.set(
        id,
        `hsl(${(colorOffset + palette.current.size * 137.508) % 360} 65% 55%)`,
      );
    return palette.current.get(id)!;
  };
  const drag = useCollectionDrag({
    rows,
    schema,
    state,
    writable,
    onMove,
    color: groupColor,
  });
  const actions = (row: ResourceRecord) =>
    renderActions ? renderActions(row, drag.handle(row)) : drag.handle(row);
  const stripes = (path: GroupSegment[]) => {
    if (!path.length) return null;
    const stops = path.map(
      (_, index) =>
        `${groupColor(path.slice(0, index + 1))} ${index * 3}px ${(index + 1) * 3}px`,
    );
    return (
      <span
        aria-hidden="true"
        data-group-stripes
        data-depth={path.length}
        className="pointer-events-none absolute -inset-y-px left-0"
        style={{
          width: path.length * 3,
          background: `linear-gradient(to right, ${stops.join(", ")})`,
        }}
      />
    );
  };
  const title = (node: GroupNode) =>
    groupLabelValues(node)
      .map((value) =>
        value == null
          ? "Not set"
          : displayValue(value, node.labelField ?? node.field),
      )
      .join(" / ");
  const groupLabel = (node: GroupNode) => node.field.label + ": " + title(node);
  const heading = (node: GroupNode) => (
    <div
      className="flex items-center gap-2"
      style={{
        paddingInlineStart: (node.path.length - 1) * groupIndent,
      }}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        data-group-toggle-level={node.path.length}
        aria-label={
          (collapsed.has(node.id) ? "Expand " : "Collapse ") + groupLabel(node)
        }
        aria-expanded={!collapsed.has(node.id)}
        onClick={() => toggle(node.id)}
      >
        {collapsed.has(node.id) ? <ChevronRight /> : <ChevronDown />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        data-group-open
        aria-label={"Open group " + groupLabel(node)}
        onClick={() => go(node.path)}
      >
        <ArrowRight />
      </Button>
      <span
        data-group-count
        className="text-xs text-muted-foreground tabular-nums shrink-0"
      >
        {node.rows.length}
      </span>
      <span className="text-muted-foreground">{node.field.label}</span>
      {!node.materializedRows?.length && (
        <span
          className={cn(
            "min-w-0 font-medium",
            short || board || folder
              ? "whitespace-normal [overflow-wrap:anywhere]"
              : "whitespace-nowrap",
          )}
        >
          {title(node)}
        </span>
      )}
    </div>
  );
  const cell = (row: ResourceRecord, field: Field) => {
    const value = row.data[field.id],
      text = displayValue(value, field);
    const content =
      field.control === "markdown" ? (
        <MarkdownInput
          value={value == null ? "" : String(value)}
          label={field.label}
          disabled
        />
      ) : ["title", "name", "summary", "subject"].includes(field.id) &&
        onOpen ? (
        <button
          type="button"
          className="text-left font-medium hover:underline [overflow-wrap:anywhere]"
          onClick={() => onOpen(row)}
        >
          {value == null || value === "" ? "Untitled" : text}
        </button>
      ) : (
        text
      );
    return renderCell
      ? renderCell({
          row,
          field,
          value,
          defaultContent: content,
          writable: writable?.(row) ?? false,
          update: (patch) =>
            onUpdate
              ? onUpdate(row, patch)
              : Promise.reject(Error("This view is read-only")),
        })
      : content;
  };
  const recordRow = (
    row: ResourceRecord,
    path: GroupSegment[] = current?.path ?? [],
    materializedGroup?: string,
  ) => (
    <Fragment key={row.id}>
      <TableRow
        data-record-id={row.id}
        data-record-depth={Math.max(
          0,
          path.length - (materializedGroup ? 1 : 0),
        )}
        {...drag.surface(path, row)}
        data-drop-position={drag.position(row.id)}
        data-drag-group={drag.highlighted(path, row.id) || undefined}
        style={drag.style(path, row.id)}
        data-materialized-group={materializedGroup}
        className={cn(
          materializedGroup && "bg-muted/50",
          drag.highlighted(path, row.id) && "transition-none",
        )}
        onDoubleClick={() => onOpen?.(row)}
      >
        <TableCell
          data-table-actions
          className="w-1 align-top relative"
          style={{ paddingInlineStart: rowInset }}
        >
          {stripes(path)}
          <div className="flex flex-nowrap items-center justify-start gap-1 whitespace-nowrap [&>*]:shrink-0">
            {actions(row)}
          </div>
        </TableCell>
        {!fields.length && (
          <TableCell>
            <Button variant="link" onClick={() => onOpen?.(row)}>
              Entry {row.id.slice(0, 8)}
            </Button>
          </TableCell>
        )}
        {fields.map((field, index) => (
          <TableCell
            key={field.id}
            data-field={field.id}
            style={{
              paddingInlineStart:
                index === 0 &&
                groupFields.some(
                  (field) => field.groupMode === "recursive" && field.reference,
                )
                  ? 8 +
                    Math.max(0, path.length - (materializedGroup ? 1 : 0)) *
                      groupStep
                  : undefined,
              width: columnOptions?.[field.id]?.width,
              minWidth:
                !short && !columnOptions?.[field.id]?.width
                  ? Math.max(
                      16,
                      ...displayValue(row.data[field.id], field)
                        .split("\n")
                        .map((line) => line.length),
                    ) + "ch"
                  : undefined,
            }}
            className={cn(
              short
                ? "whitespace-normal align-top [overflow-wrap:anywhere]"
                : "whitespace-nowrap",
              columnOptions?.[field.id]?.className,
            )}
          >
            {cell(row, field)}
          </TableCell>
        ))}
      </TableRow>
      {rowDetails?.(row) && (
        <TableRow
          {...drag.surface(path, row)}
          style={drag.style(path)}
          data-drag-group={drag.highlighted(path, row.id) || undefined}
        >
          <TableCell
            className="relative"
            style={{ paddingInlineStart: rowInset }}
            colSpan={Math.max(1, fields.length) + 1}
          >
            {stripes(path)}
            {rowDetails(row)}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
  const tableGroupHeading = (node: GroupNode, pinned = false) => (
    <Fragment key={node.id}>
      <TableRow
        data-group-heading={node.field.id}
        {...drag.surface(node.path)}
        data-drag-group={drag.highlighted(node.path) || undefined}
        style={drag.style(node.path)}
        data-group-id={node.id}
        data-pinned-group={pinned || undefined}
        className={cn(
          "bg-muted/50",
          drag.highlighted(node.path) && "transition-none",
          !!node.materializedRows?.length && "border-b-0",
        )}
      >
        <TableCell
          className="relative"
          style={{
            paddingInlineStart: 8 + node.path.length * groupStripeWidth,
          }}
          colSpan={Math.max(1, fields.length) + 1}
        >
          {stripes(node.path)}
          {heading(node)}
        </TableCell>
      </TableRow>
      {node.materializedRows?.map((row) => recordRow(row, node.path, node.id))}
    </Fragment>
  );
  const groupRows = (
    nodes: GroupNode[],
    direct: ResourceRecord[] = [],
    path: GroupSegment[] = [],
  ): ReactNode =>
    orderedGroupEntries(nodes, direct, path, rowOrder).map((entry) => {
      if (entry.kind === "row") return recordRow(entry.row, entry.path);
      const node = entry.node;
      return (
        <Fragment key={node.id}>
          {tableGroupHeading(node)}
          {!collapsed.has(node.id) &&
            groupRows(node.children, node.directRows ?? [], node.path)}
        </Fragment>
      );
    });
  const renderTable = (onlyDirect = false) => (
    <div
      className="w-full min-w-0"
      data-collection-display={short ? "short-table" : "long-table"}
    >
      <Table className={short ? "w-full" : "w-max min-w-full"}>
        <TableHeader>
          <TableRow>
            <TableHead
              data-table-actions
              className="w-1"
              style={{ paddingInlineStart: rowInset }}
            >
              <div className="flex flex-nowrap items-center justify-start gap-1 whitespace-nowrap [&>*]:shrink-0">
                {headerActions ?? "Actions"}
              </div>
            </TableHead>
            {!fields.length && <TableHead>Entry</TableHead>}
            {fields.map((field) => {
              const sort = state.query.sorts?.find(
                (s) => s.enabled && s.field === field.id,
              );
              return (
                <TableHead
                  key={field.id}
                  style={{ width: columnOptions?.[field.id]?.width }}
                  className={short ? "whitespace-normal" : "whitespace-nowrap"}
                  aria-sort={
                    sort
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="flex items-center gap-1 text-left"
                    onClick={() =>
                      onChange({
                        query: {
                          ...state.query,
                          sorts: [
                            {
                              field: field.id,
                              direction:
                                sort?.direction === "asc" ? "desc" : "asc",
                              enabled: true,
                            },
                            ...(state.query.sorts ?? []).filter(
                              (s) => s.field !== field.id,
                            ),
                          ],
                        },
                      })
                    }
                  >
                    {columnOptions?.[field.id]?.header ?? field.label}
                    {sort &&
                      (sort.direction === "asc" ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      ))}
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {!onlyDirect && createRow && (
            <TableRow data-create-row>
              <TableCell
                data-table-actions
                className="align-top"
                style={{ paddingInlineStart: rowInset }}
              >
                <div className="flex flex-nowrap items-center justify-start gap-1 whitespace-nowrap [&>*]:shrink-0">
                  {createRow.actions}
                </div>
              </TableCell>
              {!fields.length && <TableCell>New entry</TableCell>}
              {fields.map((field) => (
                <TableCell
                  key={field.id}
                  data-field={field.id}
                  className="align-top min-w-40"
                >
                  {createRow.cell(field)}
                </TableCell>
              ))}
            </TableRow>
          )}
          {!onlyDirect &&
            ancestors.map((node) => tableGroupHeading(node, true))}
          {!ancestors.some((node) => collapsed.has(node.id)) && (
            <>
              {groupRows(
                onlyDirect ? [] : children,
                scopedRows,
                current?.path ?? [],
              )}
            </>
          )}
        </TableBody>
      </Table>
    </div>
  );
  const cards = (
    items: ResourceRecord[],
    path: GroupSegment[] = current?.path ?? [],
  ) => (
    <div className="w-72 shrink-0 space-y-3 p-3">
      {items.map((row) => {
        const content = (
          <>
            <CardContent className="space-y-2">
              <div className="flex flex-nowrap items-center justify-start gap-1 whitespace-nowrap [&>*]:shrink-0">
                {actions(row)}
              </div>
              {!fields.length && (
                <Button variant="link" onClick={() => onOpen?.(row)}>
                  Entry {row.id.slice(0, 8)}
                </Button>
              )}
              {fields.map((field) => (
                <div
                  key={field.id}
                  className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"
                >
                  {!["title", "name", "summary", "subject"].includes(
                    field.id,
                  ) && (
                    <div className="text-xs text-muted-foreground">
                      {field.label}
                    </div>
                  )}
                  {cell(row, field)}
                </div>
              ))}
            </CardContent>
            {rowDetails?.(row) && <CardFooter>{rowDetails(row)}</CardFooter>}
          </>
        );
        return (
          <Card
            key={row.id}
            data-record-id={row.id}
            className="relative"
            {...drag.surface(path, row)}
            data-drop-position={drag.position(row.id)}
            data-drag-group={drag.highlighted(path, row.id) || undefined}
            style={{
              paddingInlineStart: path.length * 3,
              ...drag.style(path, row.id),
            }}
          >
            {stripes(path)}
            {renderCard ? renderCard(row, content) : content}
          </Card>
        );
      })}
    </div>
  );
  const boardGroups = (
    nodes: GroupNode[],
    direct: ResourceRecord[] = [],
    path: GroupSegment[] = [],
  ): ReactNode =>
    orderedGroupEntries(nodes, direct, path, rowOrder).map(
      (entry, index, entries) => {
        if (entry.kind === "row") {
          const sameLane = (
            candidate: typeof entry | (typeof entries)[number] | undefined,
          ) =>
            candidate?.kind === "row" &&
            JSON.stringify(candidate.path) === JSON.stringify(entry.path);
          if (sameLane(entries[index - 1])) return null;
          const lane: ResourceRecord[] = [];
          for (let i = index; i < entries.length && sameLane(entries[i]); i++) {
            const candidate = entries[i];
            if (candidate.kind === "row") lane.push(candidate.row);
          }
          return (
            <Fragment key={entry.row.id}>{cards(lane, entry.path)}</Fragment>
          );
        }
        const node = entry.node;
        return (
          <section
            key={node.id}
            data-board-group={node.field.id}
            className="relative min-w-72 shrink-0 border-r last:border-r-0"
            {...drag.surface(node.path)}
            data-drag-group={drag.highlighted(node.path) || undefined}
            style={{
              paddingInlineStart: node.path.length * 3,
              ...drag.style(node.path),
            }}
          >
            {stripes(node.path)}
            <div className="border-b bg-muted/50 py-2">
              <div
                className="sticky w-full max-w-[calc(100vw-3rem)] px-2"
                style={{ left: node.path.length * 3 }}
              >
                {heading(node)}
                {materialized(node)}
              </div>
            </div>
            {!collapsed.has(node.id) && (
              <div className="flex items-start">
                {boardGroups(node.children, node.directRows ?? [], node.path)}
              </div>
            )}
          </section>
        );
      },
    );
  const renderBoard = () => (
    <div
      className="overflow-x-auto rounded-lg border"
      data-collection-display="board"
    >
      <div className="min-w-full w-max">
        {ancestors.map((node) => (
          <div
            key={node.id}
            data-pinned-group
            className="relative border-b bg-muted/50 py-2"
            {...drag.surface(node.path)}
            data-drag-group={drag.highlighted(node.path) || undefined}
            style={{
              paddingInlineStart: node.path.length * 3,
              ...drag.style(node.path),
            }}
          >
            {stripes(node.path)}
            <div className="sticky left-0 w-full px-2">
              {heading(node)}
              {materialized(node)}
            </div>
          </div>
        ))}
        {!ancestors.some((node) => collapsed.has(node.id)) &&
          (children.length ? (
            <div className="flex items-start">
              {boardGroups(children, scopedRows, current?.path ?? [])}
            </div>
          ) : (
            cards(scopedRows)
          ))}
      </div>
    </div>
  );
  const materialized = (node: GroupNode) =>
    node.materializedRows?.length ? (
      <div
        data-materialized-group={node.id}
        className={cn(
          "min-w-0 pt-2",
          folder && !board && "overflow-x-auto overflow-y-hidden",
        )}
      >
        {board ? (
          cards(node.materializedRows, node.path)
        ) : (
          <table
            className={cn(
              "caption-bottom text-sm",
              short ? "w-full" : "w-max min-w-full",
            )}
          >
            <TableBody>
              {node.materializedRows.map((row) =>
                recordRow(row, node.path, node.id),
              )}
            </TableBody>
          </table>
        )}
      </div>
    ) : null;
  if (state.mode === "week" || state.mode === "month")
    return (
      <CalendarView
        rows={entries}
        fields={calendarFields(schema.fields)}
        mode={state.mode}
        dateField={state.dateField}
        onDateField={(dateField) => onChange({ dateField })}
        onOpen={onOpen}
        schema={schema}
        writable={writable}
        onUpdate={onUpdate}
      />
    );
  return (
    <div
      className="min-w-0 space-y-3"
      data-collection-view={state.mode}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          drag.clearTarget();
      }}
    >
      <div
        {...drag.surface([])}
        data-root-drop
        className={!showRootLabel && !ancestors.length ? "hidden" : undefined}
      >
        <Breadcrumb aria-label={schema.name + " groups"}>
          <BreadcrumbList>
            <BreadcrumbItem>
              {ancestors.length ? (
                <BreadcrumbLink
                  render={<button type="button" onClick={() => go([])} />}
                >
                  {showRootLabel ? schema.name : "All groups"}
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{schema.name}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {ancestors.map((node, index) => (
              <Fragment key={node.id}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {index === ancestors.length - 1 ? (
                    <BreadcrumbPage>{groupLabel(node)}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      render={
                        <button type="button" onClick={() => go(node.path)} />
                      }
                    >
                      {groupLabel(node)}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {!!levels.length && (
        <div
          role="group"
          aria-label="Group expansion levels"
          className="overflow-x-auto overflow-y-hidden"
        >
          <div
            className="relative h-6"
            style={{
              minWidth:
                groupToggleInset(levels.at(-1)!.depth) + groupToggleSize,
            }}
          >
            {levels.map(({ depth, nodes }) => {
              const closed = nodes.every((node) => collapsed.has(node.id));
              const label = `${closed ? "Expand" : "Collapse"} all groups at level ${depth}`;
              return (
                <Button
                  key={depth}
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-0"
                  style={{
                    width: groupStep,
                    insetInlineStart:
                      groupToggleInset(depth) +
                      (groupToggleSize - groupStep) / 2,
                  }}
                  data-group-level={depth}
                  aria-label={label}
                  title={label}
                  aria-expanded={!closed}
                  onClick={() =>
                    onChange({
                      collapsed: toggleGroupLevel(state.collapsed, nodes),
                    })
                  }
                >
                  {closed ? <ChevronRight /> : <ChevronDown />}
                </Button>
              );
            })}
          </div>
        </div>
      )}
      {(board || (folder && children.length > 0)) && (
        <>
          <div className="flex gap-1">{headerActions}</div>
          {createRow && (
            <div
              data-create-row
              className="rounded-lg border p-3 flex flex-wrap items-start gap-3"
            >
              <div className="flex gap-1">{createRow.actions}</div>
              {fields.map((field) => (
                <label key={field.id} className="min-w-40 flex-1">
                  <span className="text-xs text-muted-foreground">
                    {field.label}
                  </span>
                  {createRow.cell(field)}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {folder && children.length ? (
        <div data-collection-display="folders" className="space-y-3">
          {ancestors.map((node) => (
            <div
              key={node.id}
              data-pinned-group
              className="relative rounded-lg border bg-muted/50 p-2"
              {...drag.surface(node.path)}
              style={{
                paddingInlineStart: 8 + node.path.length * 3,
                ...drag.style(node.path),
              }}
            >
              {stripes(node.path)}
              {heading(node)}
              {materialized(node)}
            </div>
          ))}
          {!ancestors.some((node) => collapsed.has(node.id)) && (
            <>
              <p className="text-sm text-muted-foreground">
                {children[0].field.label}
              </p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
                {orderedGroupEntries(
                  children,
                  scopedRows,
                  current?.path ?? [],
                  rowOrder,
                ).map((entry) => {
                  if (entry.kind === "row")
                    return (
                      <div key={entry.row.id} className="col-span-full">
                        {board ? (
                          cards([entry.row], entry.path)
                        ) : (
                          <Table>
                            <TableBody>
                              {recordRow(entry.row, entry.path)}
                            </TableBody>
                          </Table>
                        )}
                      </div>
                    );
                  const node = entry.node;
                  return (
                    <div
                      key={node.id}
                      {...drag.surface(node.path)}
                      data-drag-group={drag.highlighted(node.path) || undefined}
                      style={drag.style(node.path)}
                      className={cn(
                        "relative min-w-0 rounded-lg border p-2",
                        !!node.materializedRows?.length && "col-span-full",
                      )}
                    >
                      {stripes(node.path)}
                      <Button
                        variant="outline"
                        className="h-auto w-full min-h-32 flex-col whitespace-normal border-0 p-4 text-center"
                        aria-label={"Open folder " + groupLabel(node)}
                        onClick={() => go(node.path)}
                      >
                        <Folder className="size-10" />
                        {!node.materializedRows?.length && (
                          <span className="[overflow-wrap:anywhere]">
                            {title(node)}
                          </span>
                        )}
                        <span className="text-xs font-normal text-muted-foreground">
                          {node.rows.length} entries
                        </span>
                      </Button>
                      {materialized(node)}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : board ? (
        renderBoard()
      ) : (
        renderTable()
      )}
      {!entries.length && (
        <p className="text-sm text-muted-foreground">No entries yet.</p>
      )}
      {showCount && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
          {ancestors.length ? " in this group" : ""}
        </p>
      )}
    </div>
  );
}
