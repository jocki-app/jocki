import { useState, type ReactNode } from "react";
import {
  Plus,
  RotateCcw,
  X,
  ArrowUp,
  ArrowDown,
  Filter,
  ArrowDownUp,
  Columns3,
  Group,
  LayoutList,
  ChevronDown,
} from "lucide-react";
import type {
  Field,
  Filter as FilterRule,
  Query,
  Sort,
} from "@jocki/platform/field-types";
import { FieldInput } from "./fields";
import { ChoiceSelect } from "./choice-select";
import { Button } from "./primitives/button";
import { Switch } from "./primitives/switch";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from "./primitives/popover";
import { Input } from "./primitives/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
} from "./primitives/dropdown-menu";
import {
  defaultVisibleColumns,
  moveRule,
  resolveColumnOrder,
  availableViewModes,
  viewLabels,
  type CollectionViewState,
  type Grouping,
  type ViewMode,
} from "./collection-view-model";

export function OrderButtons({
  index,
  count,
  kind,
  onMove,
}: {
  index: number;
  count: number;
  kind: string;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={"Move " + kind + " " + (index + 1) + " up"}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={"Move " + kind + " " + (index + 1) + " down"}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown />
      </Button>
    </div>
  );
}
const operators: Record<FilterRule["operator"], string> = {
  eq: "Equals",
  neq: "Not equal",
  contains: "Contains",
  gt: "Greater than",
  gte: "At least",
  lt: "Less than",
  lte: "At most",
  empty: "Is empty",
  "not-empty": "Is not empty",
};
export function QueryControls({
  fields,
  query,
  onChange,
  columns,
  columnOrder,
  onColumns,
  groups,
  onGroups,
  mode,
  onMode,
  defaults,
  compact = false,
}: {
  compact?: boolean;
  defaults?: Partial<CollectionViewState>;
  fields: Field[];
  query: Query;
  onChange: (query: Query) => void;
  columns: string[];
  columnOrder?: string[];
  onColumns: (columns: string[], order?: string[]) => void;
  groups: Grouping[];
  onGroups: (groups: Grouping[]) => void;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
}) {
  type Panel = "filter" | "sort" | "columns" | "group" | "view";
  const [panel, setPanel] = useState<Panel | null>(null);
  const [columnSearch, setColumnSearch] = useState("");
  const [localColumnOrder, setLocalColumnOrder] = useState(() =>
    resolveColumnOrder(fields),
  );
  const orderedColumns = resolveColumnOrder(
    fields,
    columnOrder ?? localColumnOrder,
  );
  const updateColumns = (order: string[], visible: string[]) => {
    setLocalColumnOrder(order);
    onColumns(
      order.filter((id) => visible.includes(id)),
      order,
    );
  };
  const openPanel = (name: Panel, open: boolean) =>
    setPanel((current) => (open ? name : current === name ? null : current));
  const filters = query.filters ?? [],
    sorts = query.sorts ?? [];
  const choices = fields.map((f) => ({ value: f.id, label: f.label }));
  const updateFilter = (id: string, patch: Partial<FilterRule>) =>
    onChange({
      ...query,
      filters: filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
  const updateSort = (index: number, patch: Partial<Sort>) =>
    onChange({
      ...query,
      sorts: sorts.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  const updateGroup = (id: string, patch: Partial<Grouping>) =>
    onGroups(groups.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const addButtons = {
    filter: (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Add filter"
        disabled={!fields.length || filters.length >= 100}
        onClick={() =>
          onChange({
            ...query,
            filters: [
              ...filters,
              {
                id: crypto.randomUUID(),
                field: fields[0].id,
                operator: ["text", "character varying"].includes(
                  fields[0].pgType,
                )
                  ? "contains"
                  : "eq",
                value: ["text", "character varying"].includes(fields[0].pgType)
                  ? ""
                  : null,
                link: "and",
                enabled: true,
              },
            ],
          })
        }
      >
        <Plus />
      </Button>
    ),
    sort: (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Add sort"
        disabled={!fields.length || sorts.length >= 30}
        onClick={() =>
          onChange({
            ...query,
            sorts: [
              ...sorts,
              {
                field:
                  fields.find((f) => !sorts.some((s) => s.field === f.id))
                    ?.id ?? fields[0].id,
                direction: "asc",
                enabled: true,
              },
            ],
          })
        }
      >
        <Plus />
      </Button>
    ),
    group: (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Add group"
        disabled={groups.length >= fields.length}
        onClick={() => {
          const field = fields.find(
            (f) => !groups.some((g) => g.field === f.id),
          );
          if (field)
            onGroups([
              ...groups,
              { id: crypto.randomUUID(), field: field.id, enabled: true },
            ]);
        }}
      >
        <Plus />
      </Button>
    ),
  };
  const reset = (name: "filter" | "sort" | "columns" | "group") => {
    if (name === "filter")
      onChange({ ...query, filters: defaults?.query?.filters ?? [] });
    if (name === "sort")
      onChange({ ...query, sorts: defaults?.query?.sorts ?? [] });
    if (name === "group") onGroups(defaults?.groups ?? []);
    if (name === "columns") {
      setColumnSearch("");
      updateColumns(
        resolveColumnOrder(fields, defaults?.columnOrder),
        defaults?.columns ?? defaultVisibleColumns(fields),
      );
    }
  };
  const popover = (
    name: "filter" | "sort" | "group" | "columns",
    title: string,
    icon: ReactNode,
    body: ReactNode,
    width: string,
  ) => (
    <Popover
      open={panel === name}
      onOpenChange={(open) => openPanel(name, open)}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size={compact ? "icon" : "default"}
            aria-label={title}
            title={title}
          />
        }
      >
        {icon}
        {!compact && title}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={width + " max-w-[calc(100vw-2rem)] overflow-auto"}
        aria-label={title + " settings"}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <PopoverTitle>{title}</PopoverTitle>
          <div className="flex items-center gap-1">
            {name !== "columns" && addButtons[name]}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={"Reset " + name}
              title="Reset to defaults"
              onClick={() => reset(name)}
            >
              <RotateCcw />
            </Button>
          </div>
        </div>
        {body}
      </PopoverContent>
    </Popover>
  );
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Collection controls"
    >
      {popover(
        "filter",
        "Filter",
        <Filter />,
        <>
          {!filters.length && (
            <p className="text-muted-foreground">
              No filters. All entries are included.
            </p>
          )}
          <div className="space-y-2 min-w-fit">
            {filters.map((filter, index) => {
              const field = fields.find((f) => f.id === filter.field);
              if (!field) return null;
              const available = Object.entries(operators)
                .filter(
                  ([op]) =>
                    op !== "contains" ||
                    field.array ||
                    ["text", "character varying", "jsonb"].includes(
                      field.pgType,
                    ),
                )
                .map(([value, label]) => ({ value, label }));
              return (
                <div
                  key={filter.id}
                  data-filter-row
                  className="grid grid-cols-[3.25rem_2rem_5rem_9rem_8rem_minmax(8rem,1fr)_1.5rem] items-center gap-2"
                >
                  <OrderButtons
                    kind="filter"
                    index={index}
                    count={filters.length}
                    onMove={(direction) =>
                      onChange({
                        ...query,
                        filters: moveRule(filters, index, direction),
                      })
                    }
                  />
                  <Switch
                    aria-label={"Enable filter " + (index + 1)}
                    checked={filter.enabled}
                    onCheckedChange={(enabled) =>
                      updateFilter(filter.id, { enabled })
                    }
                  />
                  {index === 0 ? (
                    <span
                      data-filter-conjunction
                      className="flex h-8 w-20 items-center px-2.5 text-sm"
                    >
                      Where
                    </span>
                  ) : (
                    <ChoiceSelect
                      aria-label={"Filter conjunction " + (index + 1)}
                      className="w-20"
                      options={[
                        { value: "and", label: "And" },
                        { value: "or", label: "Or" },
                      ]}
                      value={filter.link}
                      onValueChange={(link) =>
                        updateFilter(filter.id, { link: link as "and" | "or" })
                      }
                    />
                  )}
                  <ChoiceSelect
                    aria-label={"Filter field " + (index + 1)}
                    options={choices}
                    value={filter.field}
                    onValueChange={(field) =>
                      updateFilter(filter.id, {
                        field,
                        operator: "eq",
                        value: null,
                      })
                    }
                  />
                  <ChoiceSelect
                    aria-label={"Filter operator " + (index + 1)}
                    options={available}
                    value={filter.operator}
                    onValueChange={(operator) =>
                      updateFilter(filter.id, {
                        operator: operator as FilterRule["operator"],
                      })
                    }
                  />
                  <div className="min-w-0">
                    {!["empty", "not-empty"].includes(filter.operator) && (
                      <FieldInput
                        definition={{
                          ...field,
                          id: "filter-" + filter.id,
                          label: "Filter value " + (index + 1),
                          required: false,
                          nullable: true,
                          array:
                            filter.operator === "contains"
                              ? false
                              : field.array,
                        }}
                        value={filter.value}
                        onChange={(value) => updateFilter(filter.id, { value })}
                      />
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={"Remove filter " + (index + 1)}
                    onClick={() =>
                      onChange({
                        ...query,
                        filters: filters.filter((f) => f.id !== filter.id),
                      })
                    }
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
          </div>
        </>,
        "w-[48rem]",
      )}
      {popover(
        "sort",
        "Sort",
        <ArrowDownUp />,
        <>
          {!sorts.length && (
            <p className="text-muted-foreground">No sorting rules.</p>
          )}
          {sorts.map((sort, index) => (
            <div key={index} className="flex items-center gap-2" data-sort-row>
              <OrderButtons
                kind="sort"
                index={index}
                count={sorts.length}
                onMove={(direction) =>
                  onChange({
                    ...query,
                    sorts: moveRule(sorts, index, direction),
                  })
                }
              />
              <Switch
                aria-label={"Enable sort " + (index + 1)}
                checked={sort.enabled}
                onCheckedChange={(enabled) => updateSort(index, { enabled })}
              />
              <ChoiceSelect
                aria-label={"Sort field " + (index + 1)}
                options={choices}
                value={sort.field}
                onValueChange={(field) => updateSort(index, { field })}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={
                  "Sort " +
                  (index + 1) +
                  (sort.direction === "asc" ? " ascending" : " descending")
                }
                onClick={() =>
                  updateSort(index, {
                    direction: sort.direction === "asc" ? "desc" : "asc",
                  })
                }
              >
                {sort.direction === "asc" ? <ArrowUp /> : <ArrowDown />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={"Remove sort " + (index + 1)}
                onClick={() =>
                  onChange({
                    ...query,
                    sorts: sorts.filter((_, i) => i !== index),
                  })
                }
              >
                <X />
              </Button>
            </div>
          ))}
        </>,
        "w-[27rem]",
      )}
      {popover(
        "columns",
        "Columns",
        <Columns3 />,
        <>
          <Input
            aria-label="Find columns"
            placeholder="Find a column…"
            value={columnSearch}
            onChange={(event) => setColumnSearch(event.target.value)}
          />
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {orderedColumns.map((id, index) => {
              const field = fields.find((field) => field.id === id)!;
              if (
                !field.label
                  .toLocaleLowerCase()
                  .includes(columnSearch.trim().toLocaleLowerCase())
              )
                return null;
              return (
                <div
                  key={id}
                  data-column-row={id}
                  className="grid grid-cols-[3.25rem_2rem_minmax(0,1fr)] items-center gap-2"
                >
                  <OrderButtons
                    kind="column"
                    index={index}
                    count={orderedColumns.length}
                    onMove={(direction) =>
                      updateColumns(
                        moveRule(orderedColumns, index, direction),
                        columns,
                      )
                    }
                  />
                  <Switch
                    aria-label={"Show column " + field.label}
                    checked={columns.includes(id)}
                    onCheckedChange={(visible) =>
                      updateColumns(
                        orderedColumns,
                        visible
                          ? [...columns, id]
                          : columns.filter((column) => column !== id),
                      )
                    }
                  />
                  <span className="min-w-0 break-words text-sm">
                    {field.label}
                  </span>
                </div>
              );
            })}
            {!fields.some((field) =>
              field.label
                .toLocaleLowerCase()
                .includes(columnSearch.trim().toLocaleLowerCase()),
            ) && (
              <p className="text-sm text-muted-foreground">No columns found.</p>
            )}
          </div>
        </>,
        "w-80",
      )}
      {popover(
        "group",
        "Group",
        <Group />,
        <>
          {!groups.length && (
            <p className="text-muted-foreground">
              Add fields to create nested groups.
            </p>
          )}
          {groups.map((group, index) => (
            <div
              key={group.id}
              className="flex items-center gap-2"
              data-group-rule
            >
              <OrderButtons
                kind="group"
                index={index}
                count={groups.length}
                onMove={(direction) =>
                  onGroups(moveRule(groups, index, direction))
                }
              />
              <Switch
                aria-label={"Enable group " + (index + 1)}
                checked={group.enabled}
                onCheckedChange={(enabled) =>
                  updateGroup(group.id, { enabled })
                }
              />
              <ChoiceSelect
                aria-label={"Group field " + (index + 1)}
                value={group.field}
                options={choices.map((c) => ({
                  ...c,
                  disabled: groups.some(
                    (g) => g.id !== group.id && g.field === c.value,
                  ),
                }))}
                onValueChange={(field) =>
                  updateGroup(group.id, {
                    field,
                    labelField: undefined,
                    materialize: false,
                  })
                }
              />
              <div className="field-row min-w-32 flex-1">
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        className="w-full justify-between font-normal"
                        aria-label={"Group label " + (index + 1)}
                      />
                    }
                  >
                    {choices.find((choice) => choice.value === group.labelField)
                      ?.label ?? "Group value"}
                    <ChevronDown className="size-4 text-muted-foreground" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-max min-w-64 max-w-[calc(100vw-2rem)]"
                  >
                    <DropdownMenuRadioGroup
                      value={group.labelField ?? ""}
                      onValueChange={(labelField) =>
                        updateGroup(group.id, {
                          labelField: labelField || undefined,
                          materialize: false,
                        })
                      }
                    >
                      {[{ value: "", label: "Group value" }, ...choices].map(
                        (choice) => (
                          <div
                            key={choice.value}
                            data-group-label-option={choice.value}
                            className="flex items-center gap-2"
                          >
                            <DropdownMenuRadioItem
                              closeOnClick
                              value={choice.value}
                              className="min-w-0 flex-1 whitespace-nowrap"
                            >
                              <span className="truncate">{choice.label}</span>
                            </DropdownMenuRadioItem>
                            {fields.find((field) => field.id === choice.value)
                              ?.reference && (
                              <DropdownMenuCheckboxItem
                                closeOnClick
                                className="shrink-0 pr-1.5 [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:static [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:size-4 [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:rounded-sm [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:border"
                                aria-label={
                                  "Materialize " +
                                  choice.label +
                                  " group " +
                                  (index + 1)
                                }
                                checked={
                                  !!group.materialize &&
                                  (group.labelField ?? group.field) ===
                                    choice.value
                                }
                                onCheckedChange={(materialize) =>
                                  updateGroup(group.id, {
                                    labelField: choice.value,
                                    materialize,
                                  })
                                }
                              >
                                Materialize
                              </DropdownMenuCheckboxItem>
                            )}
                          </div>
                        ),
                      )}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <ChoiceSelect
                aria-label={"Group mode " + (index + 1)}
                value={group.mode ?? "individual"}
                options={[
                  { value: "individual", label: "Individual" },
                  { value: "recursive", label: "Recursive" },
                ]}
                onValueChange={(mode) =>
                  updateGroup(group.id, { mode: mode as Grouping["mode"] })
                }
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={"Remove group " + (index + 1)}
                onClick={() =>
                  onGroups(groups.filter((g) => g.id !== group.id))
                }
              >
                <X />
              </Button>
            </div>
          ))}
        </>,
        "w-[44rem]",
      )}
      <DropdownMenu
        modal={false}
        open={panel === "view"}
        onOpenChange={(open) => openPanel("view", open)}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size={compact ? "icon" : "default"}
              aria-label="View"
              title="View"
            />
          }
        >
          <LayoutList />
          {!compact && "View"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={mode}
            onValueChange={(value) => onMode(value as ViewMode)}
          >
            {availableViewModes(fields).map((value) => (
              <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                {viewLabels[value]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
