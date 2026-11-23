import { notify } from "./notifications";
import { Textarea } from "./primitives/textarea";
import { SharedTextarea } from "./html-controls";
import { LegacySelect, ChoiceSelect } from "./choice-select";
import { ValueCombobox, parseChipValue, valueLabel } from "./value-combobox";
import { MarkdownInput } from "./markdown-input";
import {
  useState,
  useEffect,
  useId,
  useRef,
  createContext,
  useContext,
} from "react";
import {
  initialFieldValues,
  decodeField,
  type Field,
  type Value,
  type RecordSchema,
} from "@jocki/platform/field-types";
import { Input } from "./primitives/input";
import { Button } from "./primitives/button";
import { Label } from "./primitives/label";
import { Switch } from "./primitives/switch";
export const ReferenceOptionsContext = createContext<
  Record<
    string,
    Array<{
      id: string;
      label: string;
      uid?: string;
      tableId?: string;
      values?: Record<string, Value>;
    }>
  >
>({});
export function FieldInput({
  definition: f,
  value,
  onChange,
  disabled = false,
  recordId,
  inputId,
  onDraftChange,
  onPendingChange,
  draftState,
}: {
  definition: Field;
  value: Value | undefined;
  onChange: (value: Value) => void;
  disabled?: boolean;
  recordId?: string;
  inputId?: string;
  onDraftChange?: () => void;
  onPendingChange?: (pending: boolean) => void;
  draftState?: { text?: string; pending?: boolean; value?: string };
}) {
  const references = useContext(ReferenceOptionsContext);
  disabled = disabled || f.visibility === "viewable";
  const uniqueId = useId();
  const common = { id: inputId ?? uniqueId, disabled, "aria-label": f.label };
  const text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
  const options = f.options ?? f.choices;
  if (f.control === "markdown")
    return (
      <MarkdownInput
        value={text}
        onChange={onChange}
        disabled={disabled}
        label={f.label}
        inputId={common.id}
      />
    );
  if (
    !f.reference &&
    options &&
    (f.inputMode === "select" || f.inputMode === "multiselect")
  ) {
    if (f.inputMode === "select")
      return (
        <ChoiceSelect
          aria-label={f.label}
          disabled={disabled}
          value={String(
            options.findIndex(
              (option) => JSON.stringify(option) === JSON.stringify(value),
            ),
          )}
          options={[
            ...(f.nullable ? [{ value: "-1", label: "Not set" }] : []),
            ...options.map((option, index) => ({
              value: String(index),
              label: valueLabel(option),
            })),
          ]}
          onValueChange={(index) =>
            onChange(index === "-1" ? null : options[Number(index)])
          }
        />
      );
  }
  if (f.array) {
    const referenceOptions = f.reference
      ? (references[f.reference] ?? [])
          .filter(
            (item) =>
              (!f.referenceTable || item.tableId === f.referenceTable) &&
              (f.relationship !== "parent" || item.id !== recordId),
          )
          .map((item) => ({
            value:
              item.values?.[f.referenceField ?? "id"] ??
              (f.referenceField === "uid" ? (item.uid ?? item.id) : item.id),
            label:
              f.referenceLabelField && item.values
                ? valueLabel(item.values[f.referenceLabelField])
                : item.label,
          }))
      : undefined;
    const choices =
      options?.map((option) => ({
        value: option,
        label: valueLabel(option),
      })) ?? referenceOptions;
    return (
      <ValueCombobox
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        label={f.label}
        inputId={common.id}
        disabled={disabled}
        options={choices}
        create={choices ? undefined : (text) => parseChipValue(f, text)}
        unique={!!choices}
        minItems={value == null && !f.required ? undefined : f.minItems}
        maxItems={f.maxItems}
        onDraftChange={onDraftChange}
        onPendingChange={onPendingChange}
        draftState={draftState}
      />
    );
  }
  if (f.reference) {
    const options = (references[f.reference] ?? [])
      .filter(
        (item) =>
          (!f.referenceTable || item.tableId === f.referenceTable) &&
          (f.relationship !== "parent" || item.id !== recordId),
      )
      .map((item) => ({
        value:
          item.values?.[f.referenceField ?? "id"] ??
          (f.referenceField === "uid" ? (item.uid ?? item.id) : item.id),
        label:
          f.referenceLabelField && item.values
            ? valueLabel(item.values[f.referenceLabelField])
            : item.label,
      }));
    const unique = options.filter(
      (option, index) =>
        option.value != null &&
        options.findIndex(
          (other) => String(other.value) === String(option.value),
        ) === index,
    );
    return (
      <ChoiceSelect
        {...common}
        value={text}
        options={[
          { value: "", label: "Not set" },
          ...(text && !unique.some((item) => String(item.value) === text)
            ? [{ value: text, label: `Unavailable reference (${text})` }]
            : []),
          ...unique.map((item) => ({
            value: String(item.value),
            label: item.label,
          })),
        ]}
        onValueChange={(value) =>
          onChange(
            value === ""
              ? null
              : (unique.find((item) => String(item.value) === value)?.value ??
                  value),
          )
        }
      />
    );
  }
  if (f.pgType === "boolean" && f.nullable)
    return (
      <LegacySelect
        {...common}
        className="core-select"
        value={value == null ? "" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : e.target.value === "true")
        }
      >
        <option value="">Not set</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </LegacySelect>
    );
  if (f.pgType === "boolean")
    return (
      <Switch
        id={common.id}
        aria-label={f.label}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    );
  if (f.choices && !f.array)
    return (
      <LegacySelect
        {...common}
        className="core-select"
        value={text}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Choose…</option>
        {f.choices.map((choice) => (
          <option key={choice}>{choice}</option>
        ))}
      </LegacySelect>
    );
  if (f.pgType === "jsonb")
    return (
      <JsonInput
        onDraftChange={onDraftChange}
        onPendingChange={onPendingChange}
        draftState={draftState}
        value={value ?? null}
        onChange={onChange}
        label={f.label}
        disabled={disabled}
      />
    );
  if (f.control === "textarea")
    return (
      <SharedTextarea
        {...common}
        className="core-textarea"
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  const numeric = ["integer", "smallint", "double precision"].includes(
    f.pgType,
  );
  const inputType =
    f.pgType === "date"
      ? "date"
      : f.pgType === "time without time zone"
        ? "time"
        : f.pgType.startsWith("timestamp")
          ? "datetime-local"
          : numeric
            ? "number"
            : f.control === "password"
              ? "password"
              : f.control === "email"
                ? "email"
                : f.control === "url"
                  ? "url"
                  : "text";
  let display = text;
  if (
    inputType === "datetime-local" &&
    text &&
    f.pgType === "timestamp with time zone"
  ) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime()))
      display = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 19);
  }
  return (
    <Input
      {...common}
      type={inputType}
      value={display}
      min={f.min}
      max={f.max}
      step={
        inputType === "datetime-local" || inputType === "time"
          ? 1
          : numeric
            ? "any"
            : undefined
      }
      onChange={(event) => {
        const next = event.target.value;
        if (!next) {
          onChange(f.nullable ? null : "");
          return;
        }
        if (numeric) onChange(Number(next));
        else if (inputType === "datetime-local")
          onChange(
            f.pgType === "timestamp with time zone"
              ? new Date(next).toISOString()
              : next.length === 16
                ? next + ":00"
                : next,
          );
        else if (inputType === "time")
          onChange(next.length === 5 ? next + ":00" : next);
        else onChange(next);
      }}
    />
  );
}
function JsonInput({
  value,
  onChange,
  label,
  disabled,
  onDraftChange,
  onPendingChange,
  draftState,
}: {
  value: Value;
  onChange: (v: Value) => void;
  label: string;
  disabled: boolean;
  onDraftChange?: () => void;
  onPendingChange?: (pending: boolean) => void;
  draftState?: { text?: string; pending?: boolean; value?: string };
}) {
  const lastValue = useRef(JSON.stringify(value));
  const [draft, setDraft] = useState(
    draftState?.pending
      ? (draftState.text ?? "")
      : JSON.stringify(value, null, 2),
  );
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (lastValue.current !== JSON.stringify(value)) {
      lastValue.current = JSON.stringify(value);
      setDraft(JSON.stringify(value, null, 2));
      input.current?.setCustomValidity("");
    }
  }, [value]);
  return (
    <>
      <Textarea
        ref={input}
        className="core-textarea font-mono"
        aria-label={label}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          if (draftState) draftState.text = event.target.value;
          onDraftChange?.();
          try {
            const parsed = JSON.parse(event.target.value);
            lastValue.current = JSON.stringify(parsed);
            onChange(parsed);
            if (draftState) draftState.pending = false;
            onPendingChange?.(false);
            event.target.setCustomValidity("");
          } catch {
            if (draftState) draftState.pending = true;
            onPendingChange?.(true);
            event.target.setCustomValidity("Enter valid JSON");
          }
        }}
      />
    </>
  );
}
export function displayValue(value: Value | undefined, f?: Field): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return value
      .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
      .join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  if (f?.pgType === "timestamp with time zone")
    return new Date(String(value)).toLocaleString();
  return String(value);
}
export function RecordForm({
  schema,
  initial,
  onSave,
  onCancel,
}: {
  schema: RecordSchema;
  initial?: Record<string, Value>;
  onSave: (data: Record<string, Value>) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, Value>>(() => ({
    ...initialFieldValues(schema.fields),
    ...initial,
  }));
  const [optional, setOptional] = useState(Boolean(initial)),
    [saving, setSaving] = useState(false);
  const allFields = schema.fields;
  const generated = allFields.filter((f) => f.generated).map((f) => f.id);
  const requiredFields = allFields.filter(
    (f) => f.required && f.visibility !== "hidden" && !generated.includes(f.id),
  );
  const optionalFields = allFields.filter(
    (f) =>
      !f.required && f.visibility !== "hidden" && !generated.includes(f.id),
  );
  const inlineFields = schema.tables
    ? optionalFields.filter(
        (f) => f.visibility !== "addable" || values[f.id] != null,
      )
    : [];
  const additionalFields = optionalFields.filter(
    (f) => !inlineFields.includes(f),
  );
  const render = (f: Field) => (
    <div key={f.id} className="field-row">
      <Label htmlFor={formId + f.id}>
        {f.label}
        {f.required && <span className="text-muted-foreground ml-1">*</span>}
      </Label>
      <FieldInput
        definition={f}
        inputId={formId + f.id}
        value={values[f.id]}
        onChange={(value) =>
          setValues((current) => ({ ...current, [f.id]: value }))
        }
      />
      {f.description && <small>{f.description}</small>}
    </div>
  );
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);

        try {
          for (const f of schema.fields)
            if (values[f.id] !== undefined) decodeField(f, values[f.id]);
          await onSave(values);
        } catch (e) {
          notify.error(e);
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-4"
    >
      {requiredFields.map(render)}
      {inlineFields.map(render)}
      {additionalFields.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOptional(!optional)}
        >
          {optional ? "Hide optional fields" : "Add optional fields"}
        </Button>
      )}
      {optional && additionalFields.map(render)}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
