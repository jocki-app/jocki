import { useState } from "react";
import {
  addDays,
  addMonths,
  startOfWeek,
  startOfMonth,
  endOfWeek,
  endOfMonth,
  eachDayOfInterval,
  format,
  isSameMonth,
} from "date-fns";
import type {
  Field,
  RecordSchema,
  Value,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { calendarEntries } from "./calendar-model";
import { RecordForm, displayValue } from "./fields";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./primitives/dialog";
import { Button } from "./primitives/button";
import { ChoiceSelect } from "./choice-select";

export function CalendarView({
  rows,
  fields,
  mode,
  dateField,
  onDateField,
  onOpen,
  schema,
  writable,
  onUpdate,
}: {
  rows: ResourceRecord[];
  fields: Field[];
  mode: "week" | "month";
  dateField?: string;
  onDateField: (id: string) => void;
  onOpen?: (row: ResourceRecord) => void;
  schema: RecordSchema;
  writable?: (row: ResourceRecord) => boolean;
  onUpdate?: (
    row: ResourceRecord,
    patch: Record<string, Value>,
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<ResourceRecord | null>(null);
  const [anchor, setAnchor] = useState(new Date());
  const field = fields.find((f) => f.id === dateField) ?? fields[0];
  if (!field) return null;
  const entries = calendarEntries(rows, field);
  const start = startOfWeek(mode === "month" ? startOfMonth(anchor) : anchor, {
    weekStartsOn: 1,
  });
  const days = eachDayOfInterval({
    start,
    end:
      mode === "month"
        ? endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 })
        : addDays(start, 6),
  });
  const labelFields = schema.fields
    .filter(
      (f) =>
        !f.sensitive &&
        f.visibility !== "hidden" &&
        !f.array &&
        ["text", "character varying"].includes(f.pgType) &&
        f.control !== "password",
    )
    .sort(
      (a, b) =>
        Number(!/^(title|name|summary|activity)$/i.test(a.label)) -
        Number(!/^(title|name|summary|activity)$/i.test(b.label)),
    );
  const label = (row: ResourceRecord) => {
    const field = labelFields.find(
      (f) => row.data[f.id] != null && String(row.data[f.id]).trim(),
    );
    return field ? displayValue(row.data[field.id], field) : "Entry";
  };
  const hidden = rows.length - entries.length;
  return (
    <div className="space-y-3" data-collection-display={mode}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          onClick={() =>
            setAnchor(
              mode === "month" ? addMonths(anchor, -1) : addDays(anchor, -7),
            )
          }
        >
          Previous
        </Button>
        <span>
          {format(anchor, mode === "month" ? "MMMM yyyy" : "MMMM d, yyyy")}
        </span>
        <Button
          variant="outline"
          onClick={() =>
            setAnchor(
              mode === "month" ? addMonths(anchor, 1) : addDays(anchor, 7),
            )
          }
        >
          Next
        </Button>
      </div>
      {fields.length > 1 && (
        <ChoiceSelect
          className="max-w-72"
          aria-label="Calendar date field"
          value={field.id}
          options={fields.map((f) => ({ value: f.id, label: f.label }))}
          onValueChange={onDateField}
        />
      )}
      <div className="overflow-x-auto">
        <div
          className={`grid gap-px rounded-xl border bg-border ${mode === "week" && field.pgType !== "date" ? "min-w-[960px] grid-cols-[56px_repeat(7,minmax(0,1fr))]" : "min-w-[700px] grid-cols-7"}`}
        >
          {mode === "week" && field.pgType !== "date" && (
            <div className="bg-background pt-10">
              {Array.from({ length: 24 }, (_, hour) => (
                <div
                  key={hour}
                  className="h-8 pr-2 text-right text-xs text-muted-foreground"
                >
                  {String(hour).padStart(2, "0")}:00
                </div>
              ))}
            </div>
          )}
          {days.map((day) => {
            const items = entries.filter(
              (entry) =>
                +entry.start < +addDays(day, 1) &&
                (+entry.end > +day || +entry.start === +day),
            );
            const timeline = mode === "week" && field.pgType !== "date";
            const laneEnds: number[] = [];
            const positioned = [...items]
              .sort((a, b) => +a.start - +b.start)
              .map((entry) => {
                const from = Math.max(+day, +entry.start),
                  to = Math.min(+addDays(day, 1), +entry.end);
                let lane = laneEnds.findIndex((end) => end <= from);
                if (lane < 0) lane = laneEnds.length;
                laneEnds[lane] = Math.max(to, from + 30 * 60000);
                return { ...entry, from, to, lane };
              });
            return (
              <section
                key={day.toISOString()}
                className={`bg-background p-2 ${!isSameMonth(day, anchor) && mode === "month" ? "text-muted-foreground" : ""}`}
              >
                <h4 className="mb-3 h-6 text-center text-xs font-medium">
                  {format(day, "EEE d")}
                </h4>
                <div
                  className={
                    timeline
                      ? "relative h-[768px] overflow-hidden rounded-lg border"
                      : "min-h-24"
                  }
                >
                  {timeline &&
                    Array.from({ length: 24 }, (_, hour) => (
                      <div
                        key={hour}
                        className="absolute inset-x-0 h-8 border-b"
                        style={{ top: hour * 32 }}
                      />
                    ))}
                  {positioned.map((entry) => (
                    <button
                      type="button"
                      key={entry.row.id}
                      onClick={() =>
                        onOpen ? onOpen(entry.row) : setSelected(entry.row)
                      }
                      className={
                        timeline
                          ? "absolute overflow-hidden rounded-md bg-primary px-1 py-1 text-left text-xs text-primary-foreground"
                          : "mb-2 w-full rounded-md bg-primary/10 p-2 text-left text-xs"
                      }
                      style={
                        timeline
                          ? {
                              top:
                                ((new Date(entry.from).getHours() * 60 +
                                  new Date(entry.from).getMinutes()) /
                                  60) *
                                32,
                              height: Math.max(
                                16,
                                ((entry.to - entry.from) / 3600000) * 32,
                              ),
                              left: `calc(${(entry.lane / laneEnds.length) * 100}% + 2px)`,
                              width: `calc(${100 / laneEnds.length}% - 4px)`,
                            }
                          : undefined
                      }
                    >
                      <span className="font-medium">{label(entry.row)}</span>
                      {!timeline && !entry.allDay && (
                        <span className="block">
                          {format(entry.start, "HH:mm")}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Entry</DialogTitle>
          </DialogHeader>
          {selected &&
            (onUpdate && writable?.(selected) ? (
              <RecordForm
                key={selected.id}
                schema={schema}
                initial={selected.data}
                onCancel={() => setSelected(null)}
                onSave={async (data) => {
                  await onUpdate(selected, data);
                  setSelected(null);
                }}
              />
            ) : (
              <dl>
                {schema.fields
                  .filter((f) => f.visibility !== "hidden")
                  .map((f) => (
                    <div key={f.id}>
                      <dt>{f.label}</dt>
                      <dd>{displayValue(selected.data[f.id], f)}</dd>
                    </div>
                  ))}
              </dl>
            ))}
        </DialogContent>
      </Dialog>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {entries.length} {entries.length === 1 ? "entry" : "entries"}
        {hidden > 0 && (
          <span title={`Missing or invalid ${field.label}`}>
            {" "}
            · {hidden} hidden
          </span>
        )}
      </p>
    </div>
  );
}
