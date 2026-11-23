import { useNotificationState } from "./notifications";
import { useState, useId, type ReactNode } from "react";
import {
  field,
  fieldTypes,
  fieldTypeId,
  fieldVisibilityOptions,
  type Field,
  type Value,
} from "@jocki/platform/field-types";
import { ValueCombobox, parseChipValue } from "./value-combobox";
import { FieldInput } from "./fields";
import { ChoiceSelect } from "./choice-select";
import { Button } from "./primitives/button";
import { Input } from "./primitives/input";
import { Switch } from "./primitives/switch";
import { Label } from "./primitives/label";
export function ColumnEditor({
  initial,
  isNew = false,
  standard,
  onSave,
  disabled = false,
  render,
  allowShared = false,
  types = fieldTypes,
  initialType,
  referenceTargets,
}: {
  allowShared?: boolean;
  types?: typeof fieldTypes;
  initialType?: string;
  referenceTargets?: Record<string, string[]>;
  initial?: Field;
  isNew?: boolean;
  standard: boolean;
  onSave: (field: Field) => Promise<void>;
  disabled?: boolean;
  render?: (editor: {
    cells: Record<string, ReactNode>;
    save: () => Promise<boolean>;
    error: string;
    dirty: boolean;
  }) => ReactNode;
}): ReactNode {
  const controlId = useId();
  const [scope, setScope] = useState(initial?.scope ?? "plugin");
  const [id, setId] = useState(initial?.id ?? ""),
    [label, setLabel] = useState(initial?.label ?? ""),
    [type, setType] = useState(initial?.pgType ?? "text"),
    [typeId, setTypeId] = useState(
      initialType ??
        (initial?.control === "select" && types.enum
          ? "enum"
          : initial && types[fieldTypeId(initial)]
            ? fieldTypeId(initial)
            : "text"),
    ),
    [reference, setReference] = useState(initial?.reference ?? "resources"),
    [referenceField, setReferenceField] = useState(
      initial?.referenceField ?? (initial?.reference ? "id" : "uid"),
    ),
    [referenceLabelField, setReferenceLabelField] = useState(
      initial?.referenceLabelField ?? "",
    ),
    [referenceTable, setReferenceTable] = useState(
      initial?.referenceTable ?? "",
    ),
    [mode, setMode] = useState<NonNullable<Field["inputMode"]>>(
      initial?.inputMode ??
        (initial?.array ? "list" : initial?.choices ? "select" : "single"),
    ),
    [options, setOptions] = useState<Value[]>(
      initial?.options ?? initial?.choices ?? [],
    ),
    [optionsPending, setOptionsPending] = useState(false),
    [defaultPending, setDefaultPending] = useState(false),
    [required, setRequired] = useState(initial?.required ?? false),
    [visibility, setVisibility] = useState(
      initial?.visibility ?? (initial?.generated ? "viewable" : "editable"),
    ),
    [minItems, setMinItems] = useState(initial?.minItems?.toString() ?? ""),
    [maxItems, setMaxItems] = useState(initial?.maxItems?.toString() ?? ""),
    [hasDefault, setHasDefault] = useState(initial?.default !== undefined),
    [defaultValue, setDefaultValue] = useState<Value>(
      (initial?.default as Value) ?? null,
    ),
    [error, setError] = useNotificationState("error");
  const allowedVisibility = fieldVisibilityOptions({
    generated: initial?.generated,
    required,
    default: hasDefault ? defaultValue : undefined,
  });
  const effectiveVisibility = allowedVisibility.includes(visibility)
    ? visibility
    : allowedVisibility[0];
  const scalarConstraints = {
    min: initial?.pgType === type ? initial.min : undefined,
    max: initial?.pgType === type ? initial.max : undefined,
    length: initial?.pgType === type ? initial.length : undefined,
    precision: initial?.pgType === type ? initial.precision : undefined,
    scale: initial?.pgType === type ? initial.scale : undefined,
  };
  const descriptor = () =>
    field(
      id,
      label,
      type,
      standard
        ? { ...initial, label, visibility: effectiveVisibility }
        : {
            ...initial,
            label,
            pgType: type,
            control:
              types[typeId].definition.control ??
              (initial?.pgType === type && !types["parent"]
                ? initial.control
                : undefined),
            reference: ["parent", "reference"].includes(typeId)
              ? reference
              : !types["parent"] && initial?.pgType === type
                ? initial?.reference
                : undefined,
            referenceField: ["parent", "reference"].includes(typeId)
              ? referenceField
              : !types["parent"] && initial?.pgType === type
                ? initial?.referenceField
                : undefined,
            referenceLabelField: ["parent", "reference"].includes(typeId)
              ? referenceLabelField || undefined
              : undefined,
            referenceTable: ["parent", "reference"].includes(typeId)
              ? referenceTable || undefined
              : undefined,
            relationship:
              typeId === "parent"
                ? "parent"
                : typeId === "reference"
                  ? "reference"
                  : !types["parent"] && initial?.pgType === type
                    ? initial?.relationship
                    : undefined,
            ...scalarConstraints,
            array: ["list", "multiselect"].includes(mode),
            inputMode: mode,
            required,
            nullable: !required,
            visibility: effectiveVisibility,
            storage: "custom",
            ...(allowShared ? { scope } : {}),
            generated: undefined,
            choices: undefined,
            options: ["select", "multiselect"].includes(mode)
              ? options
              : undefined,
            minItems:
              ["list", "multiselect"].includes(mode) && minItems
                ? Number(minItems)
                : undefined,
            maxItems:
              ["list", "multiselect"].includes(mode) && maxItems
                ? Number(maxItems)
                : undefined,
            default: hasDefault ? defaultValue : undefined,
          },
    );
  // Compare effective descriptors so undoing a change also clears the draft.
  // Invalid input must remain dirty and discardable while the user fixes it.
  const snapshot = (() => {
    try {
      return JSON.stringify(descriptor());
    } catch {
      return JSON.stringify([
        id,
        label,
        type,
        typeId,
        reference,
        referenceField,
        referenceLabelField,
        referenceTable,
        mode,
        options,
        required,
        visibility,
        minItems,
        maxItems,
        hasDefault,
        defaultValue,
      ]);
    }
  })();
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot);
  const dirty =
    snapshot !== savedSnapshot ||
    (optionsPending && ["select", "multiselect"].includes(mode)) ||
    (defaultPending && hasDefault);
  const save = async () => {
    if (disabled || (!dirty && !isNew)) return false;
    try {
      if (
        (optionsPending && ["select", "multiselect"].includes(mode)) ||
        (defaultPending && hasDefault)
      )
        throw Error(
          "Choose Create to add the pending value, or clear it before saving.",
        );
      if (!/^[a-z][a-z0-9_]*$/.test(id))
        throw Error(
          "Column ID must start with a lowercase letter and contain only lowercase letters, numbers and underscores.",
        );
      if (!label.trim()) throw Error("A column label is required.");
      if (
        minItems &&
        (!Number.isInteger(Number(minItems)) || Number(minItems) < 0)
      )
        throw Error("Minimum inputs must be a nonnegative integer.");
      if (
        maxItems &&
        (!Number.isInteger(Number(maxItems)) ||
          Number(maxItems) < 1 ||
          Number(maxItems) < Number(minItems))
      )
        throw Error(
          "Maximum inputs must be a positive integer at least as large as minimum inputs.",
        );
      await onSave(descriptor());
      setSavedSnapshot(snapshot);
      setError("");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };
  const cellLabel = (text: string, multiple = false) => (
    <span className={render && !multiple ? "sr-only" : undefined}>{text}</span>
  );
  const cells: Record<string, ReactNode> = {
    id: (
      <>
        <label className="field-row">
          {cellLabel("Column ID")}
          <Input
            value={id}
            disabled={disabled || (Boolean(initial) && !isNew)}
            required
            pattern="[a-z][a-z0-9_]*"
            onChange={(e) => setId(e.target.value)}
          />
        </label>
      </>
    ),
    label: (
      <>
        <label className="field-row">
          {cellLabel("Label")}
          <Input
            value={label}
            disabled={disabled}
            required
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      </>
    ),
    type: (
      <>
        <label className="field-row">
          {cellLabel("Base type", ["parent", "reference"].includes(typeId))}
          <ChoiceSelect
            aria-label="Base type"
            disabled={disabled || standard}
            value={typeId}
            options={Object.entries(types).map(([value, definition]) => ({
              value,
              label: definition.label,
            }))}
            onValueChange={(value) => {
              setTypeId(value);
              if (value === "enum") setMode("select");
              setType(types[value].definition.pgType);
              if (["parent", "reference"].includes(value))
                setReferenceField(referenceTargets ? "id" : "uid");
              if (["parent", "sorting", "markdown"].includes(value)) {
                setMode("single");
                setDefaultPending(false);
                setDefaultValue((current) =>
                  Array.isArray(current) ? (current[0] ?? null) : current,
                );
                setMinItems("");
                setMaxItems("");
              }
            }}
          />
        </label>
        {["parent", "reference"].includes(typeId) && (
          <div className="space-y-3">
            <label className="field-row">
              {cellLabel("Target collection", true)}
              <Input
                aria-label="Target collection"
                value={reference}
                disabled={disabled || standard}
                onChange={(event) => setReference(event.target.value)}
                placeholder={
                  referenceTargets
                    ? "public.tasks"
                    : "resources (all collections)"
                }
              />
            </label>
            <label className="field-row">
              {cellLabel("Target identifier", true)}
              {referenceTargets ? (
                <Input
                  aria-label="Target identifier"
                  value={referenceField}
                  disabled={disabled || standard}
                  onChange={(event) => setReferenceField(event.target.value)}
                  list={controlId + "-target-fields"}
                />
              ) : (
                <ChoiceSelect
                  aria-label="Target identifier"
                  value={referenceField}
                  disabled={disabled || standard}
                  options={[
                    { value: "uid", label: "Item UID (core ID when absent)" },
                    { value: "id", label: "Core record ID" },
                  ]}
                  onValueChange={(value) => {
                    setReferenceField(value);
                    setType(value === "id" ? "uuid" : "text");
                  }}
                />
              )}
              {referenceTargets && (
                <datalist id={controlId + "-target-fields"}>
                  {(referenceTargets[reference] ?? []).map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              )}
            </label>
            {referenceTargets && (
              <label className="field-row">
                {cellLabel("Label field", true)}
                <Input
                  aria-label="Reference label field"
                  value={referenceLabelField}
                  disabled={disabled || standard}
                  onChange={(event) =>
                    setReferenceLabelField(event.target.value)
                  }
                  list={controlId + "-target-fields"}
                />
              </label>
            )}
            {!referenceTargets && (
              <label className="field-row">
                {cellLabel("Target table (optional UUID)", true)}
                <Input
                  aria-label="Target table"
                  value={referenceTable}
                  disabled={disabled || standard}
                  onChange={(event) => setReferenceTable(event.target.value)}
                />
              </label>
            )}
          </div>
        )}
      </>
    ),
    input: (
      <>
        <label className="field-row">
          {cellLabel("Input mode", mode !== "single")}
          <ChoiceSelect
            aria-label="Input mode"
            value={mode}
            disabled={
              disabled ||
              standard ||
              ["parent", "sorting", "markdown"].includes(typeId)
            }
            options={[
              { value: "single", label: "One value" },
              { value: "select", label: "One selection" },
              { value: "multiselect", label: "Multiple selections" },
              { value: "list", label: "Multiple values" },
            ]}
            onValueChange={(value) => {
              setMode(value as typeof mode);
              setDefaultPending(false);
              if (
                ["list", "multiselect"].includes(value) !==
                ["list", "multiselect"].includes(mode)
              )
                setDefaultValue(
                  ["list", "multiselect"].includes(value)
                    ? defaultValue == null
                      ? []
                      : [defaultValue]
                    : Array.isArray(defaultValue)
                      ? (defaultValue[0] ?? null)
                      : defaultValue,
                );
            }}
          />
        </label>
        {["select", "multiselect"].includes(mode) && (
          <label className="field-row">
            {cellLabel("Options", true)}
            <ValueCombobox
              key={type}
              label="Column options"
              disabled={disabled || standard}
              value={options}
              onChange={(next) => {
                setOptions(next);
                if (
                  mode === "select" &&
                  !next.some(
                    (v) => JSON.stringify(v) === JSON.stringify(defaultValue),
                  )
                )
                  setDefaultValue(null);
                if (mode === "multiselect" && Array.isArray(defaultValue))
                  setDefaultValue(
                    defaultValue.filter((v) =>
                      next.some(
                        (option) =>
                          JSON.stringify(option) === JSON.stringify(v),
                      ),
                    ),
                  );
              }}
              create={(text) =>
                parseChipValue(
                  field("option", "Option", type, scalarConstraints),
                  text,
                )
              }
              onPendingChange={setOptionsPending}
            />
          </label>
        )}
        {["list", "multiselect"].includes(mode) && (
          <div className="grid grid-cols-2 gap-3">
            <label className="field-row">
              {cellLabel("Minimum inputs", true)}
              <Input
                aria-label="Minimum inputs"
                type="number"
                min={0}
                disabled={disabled || standard}
                value={minItems}
                onChange={(e) => setMinItems(e.target.value)}
              />
            </label>
            <label className="field-row">
              {cellLabel("Maximum inputs", true)}
              <Input
                aria-label="Maximum inputs"
                type="number"
                min={1}
                disabled={disabled || standard}
                value={maxItems}
                onChange={(e) => setMaxItems(e.target.value)}
              />
            </label>
          </div>
        )}
      </>
    ),
    required: (
      <>
        <div className="flex items-center gap-3">
          <Switch
            id={controlId + "-required"}
            aria-labelledby={controlId + "-required-label"}
            disabled={disabled || standard}
            checked={required}
            onCheckedChange={setRequired}
          />
          <Label
            className={render ? "sr-only" : undefined}
            id={controlId + "-required-label"}
            htmlFor={controlId + "-required"}
          >
            Required
          </Label>
        </div>
      </>
    ),
    visibility: (
      <>
        <label className="field-row">
          {cellLabel("Visibility")}
          <ChoiceSelect
            aria-label="Column visibility"
            disabled={disabled}
            value={effectiveVisibility}
            options={[
              { value: "editable", label: "Editable" },
              { value: "viewable", label: "Read only" },
              { value: "hidden", label: "Hidden" },
              { value: "addable", label: "Add when needed" },
            ].filter((option) =>
              allowedVisibility.includes(option.value as typeof visibility),
            )}
            onValueChange={(value) => setVisibility(value as typeof visibility)}
          />
        </label>
      </>
    ),
    default: (
      <>
        <div className="flex items-center gap-3">
          <Switch
            id={controlId + "-default"}
            aria-labelledby={controlId + "-default-label"}
            disabled={disabled || standard}
            checked={hasDefault}
            onCheckedChange={(checked) => {
              setHasDefault(checked);
              setDefaultPending(false);
            }}
          />
          <Label
            className={render && !hasDefault ? "sr-only" : undefined}
            id={controlId + "-default-label"}
            htmlFor={controlId + "-default"}
          >
            Default value
          </Label>
        </div>
        {hasDefault && (
          <div className="field-row">
            {cellLabel("Value", true)}
            <FieldInput
              definition={field("column_default", "Default value", type, {
                ...scalarConstraints,
                control:
                  types[typeId].definition.control ??
                  (initial?.pgType === type && !types["parent"]
                    ? initial.control
                    : undefined),
                array: ["list", "multiselect"].includes(mode),
                inputMode: mode,
                options: ["select", "multiselect"].includes(mode)
                  ? options
                  : undefined,
                minItems: minItems ? Number(minItems) : undefined,
                maxItems: maxItems ? Number(maxItems) : undefined,
              })}
              key={typeId + ":" + mode}
              value={defaultValue}
              onChange={setDefaultValue}
              onPendingChange={setDefaultPending}
              disabled={disabled || standard}
            />
          </div>
        )}
      </>
    ),
  };
  if (allowShared)
    cells.scope = (
      <ChoiceSelect
        aria-label="Column storage"
        value={scope}
        disabled={disabled || standard || (Boolean(initial) && !isNew)}
        options={[
          { value: "plugin", label: "This plugin" },
          { value: "shared", label: "Shared item" },
        ]}
        onValueChange={(v) => setScope(v as "plugin" | "shared")}
      />
    );
  if (render) return render({ cells, save, error, dirty });
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {Object.entries(cells).map(([name, cell]) => (
        <div key={name}>{cell}</div>
      ))}

      <Button type="submit" disabled={disabled || !dirty}>
        Save column
      </Button>
    </form>
  );
}
