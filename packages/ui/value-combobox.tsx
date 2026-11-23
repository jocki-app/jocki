import { useEffect, useRef, useState } from "react";
import {
  decodeField,
  type Field,
  type Value,
} from "@jocki/platform/field-types";
import { notify } from "./notifications";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "./primitives/combobox";

export const valueLabel = (value: Value): string =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

/** Parse one chip without losing exact decimal/bigint values or JSON types. */
export function parseChipValue(definition: Field, text: string): Value {
  let value: unknown = text;
  if (["smallint", "integer", "double precision"].includes(definition.pgType)) {
    if (!text.trim()) throw Error("Enter a value first.");
    value = Number(text);
  } else if (["boolean", "jsonb"].includes(definition.pgType))
    value = JSON.parse(text);
  return decodeField(
    {
      ...definition,
      array: false,
      inputMode: "single",
      nullable: false,
      options: undefined,
      choices: undefined,
    },
    value,
  );
}
export interface ValueOption {
  value: Value;
  label: string;
  disabled?: boolean;
}
interface Item extends ValueOption {
  key: string;
  create?: boolean;
}
/** Shared chips for declared selections and Create-only typed lists/options.
 * Values stay controlled so optimistic reconciliation and discard update the chips.
 */
export function ValueCombobox({
  value,
  onChange,
  options = [],
  create,
  unique = true,
  label,
  disabled = false,
  minItems,
  maxItems,
  inputId,
  name,
  className,
  onDraftChange,
  onPendingChange,
  draftState,
}: {
  value: Value[];
  onChange: (value: Value[]) => void;
  options?: ValueOption[];
  /** When supplied, the menu contains only Create (no suggested options). */
  create?: (text: string) => Value;
  unique?: boolean;
  label: string;
  disabled?: boolean;
  minItems?: number;
  maxItems?: number;
  inputId?: string;
  name?: string;
  className?: string;
  onDraftChange?: () => void;
  onPendingChange?: (pending: boolean) => void;
  draftState?: { text?: string; pending?: boolean; value?: string };
}) {
  const anchor = useComboboxAnchor();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(draftState?.text ?? "");
  const serialized = JSON.stringify(value);
  const pendingChange = useRef(onPendingChange);
  pendingChange.current = onPendingChange;
  useEffect(() => {
    if (draftState?.pending && draftState.value === serialized) return;
    setQuery("");
    if (draftState) {
      draftState.text = "";
      draftState.pending = false;
      draftState.value = serialized;
    }
    pendingChange.current?.(false);
  }, [serialized]);
  const atMax = maxItems !== undefined && value.length >= maxItems;
  const counts = new Map<string, number>();
  const selected: Item[] = value.map((v) => {
    const key = JSON.stringify(v),
      occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    return {
      value: v,
      key: key + ":" + occurrence,
      label:
        options.find((o) => JSON.stringify(o.value) === key)?.label ??
        valueLabel(v),
    };
  });
  const items: Item[] = create
    ? [
        {
          key: "$create",
          value: null,
          label: "Create",
          create: true,
          disabled: atMax || !query.trim(),
        },
      ]
    : options.map((option) => ({
        ...option,
        key: JSON.stringify(option.value) + ":0",
      }));
  const validity =
    create && query.trim()
      ? "Choose Create to add this value, or clear the input before saving."
      : minItems !== undefined && value.length < minItems
        ? `Choose at least ${minItems} values.`
        : maxItems !== undefined && value.length > maxItems
          ? `Choose at most ${maxItems} values.`
          : "";
  useEffect(() => {
    input.current?.setCustomValidity(validity);
  }, [validity]);
  return (
    <Combobox<Item, true>
      multiple
      name={name}
      autoHighlight
      disabled={disabled}
      items={items}
      value={selected}
      inputValue={query}
      filter={create ? null : undefined}
      isItemEqualToValue={(a, b) => a.key === b.key}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => valueLabel(item.value)}
      onInputValueChange={(text, details) => {
        // Keep uncreated text through popup close and failed validation.
        if (create && details.reason !== "input-change") return;
        setQuery(text);
        if (draftState) {
          draftState.text = text;
          draftState.value = serialized;
          draftState.pending = !!create && !!text.trim();
        }
        if (create) {
          onPendingChange?.(!!text.trim());
          if (text.trim() && details.reason === "input-change")
            onDraftChange?.();
        }
      }}
      onValueChange={(next, details) => {
        if (disabled) {
          details.cancel();
          return;
        }
        const creating = next.some((item) => item.create);
        if (next.length > value.length && atMax) {
          details.cancel();
          return;
        }
        try {
          const values = creating
            ? [...value, create!(query)]
            : next.map((item) => item.value);
          if (
            unique &&
            new Set(values.map((v) => JSON.stringify(v))).size !== values.length
          )
            throw Error("This value is already included.");
          setQuery("");
          if (draftState) {
            draftState.text = "";
            draftState.pending = false;
          }
          onPendingChange?.(false);
          onChange(values);
        } catch (error) {
          details.cancel();
          notify.error(error);
        }
      }}
    >
      <ComboboxChips
        ref={anchor}
        className={["w-full min-w-0", className].filter(Boolean).join(" ")}
        aria-label={label + " values"}
      >
        <ComboboxValue>
          {(values: Item[]) => (
            <>
              {values.map((item) => (
                <ComboboxChip
                  key={item.key}
                  showRemove={!disabled}
                  aria-label={item.label}
                >
                  <span className="max-w-64 truncate" title={item.label}>
                    {item.label}
                  </span>
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                ref={input}
                id={inputId}
                aria-label={label}
                disabled={disabled}
                aria-invalid={!!validity || undefined}
                placeholder={create ? "Add a value…" : "Select…"}
                onKeyDown={(event) => {
                  // Enter must never submit the row/form while composing a chip.
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No items found.</ComboboxEmpty>
        <ComboboxList>
          {(item: Item) => {
            const checked = selected.some((v) => v.key === item.key);
            return (
              <ComboboxItem
                key={item.key}
                value={item}
                aria-label={item.label}
                disabled={item.disabled || (!checked && atMax)}
              >
                {item.label}
                {item.create && query && (
                  <span className="truncate text-muted-foreground">
                    {query}
                  </span>
                )}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
