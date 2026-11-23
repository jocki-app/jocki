import { prepareTimers } from "../platform-browser/timers";
import {
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSchema } from "@jocki/platform/core/catalog";
import { collectionColumns } from "@jocki/platform/core/collection-tables";
import {
  initialFieldValues,
  field,
  type Field,
  type Value,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import type { AppRuntime } from "./runtime";
import { belongsToTable, selectedCollectionTable } from "./collection-tables";
import { useLiveQuery } from "../data-duckdb/react";
import { FieldInput, RecordForm } from "../ui/fields";
import { notify } from "../ui/notifications";
import { LoadingSpinner } from "../ui/loading-spinner";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "../ui/primitives/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import { ChoiceSelect } from "../ui/choice-select";
import { RecordTable } from "./record-table";

export function elapsedSeconds(data: Record<string, Value>, now: number) {
  return (
    Math.max(
      0,
      Math.floor(
        ((Date.parse(String(data.ended_at || data.paused_at)) || now) -
          Date.parse(String(data.started_at)) -
          Number(data.paused_ms ?? 0)) /
          1000,
      ),
    ) || 0
  );
}
export function clockDuration(seconds: number) {
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}
function SessionClock({
  running,
  minutes,
  countdown,
}: {
  running?: ResourceRecord;
  minutes: number;
  countdown: boolean;
}) {
  const now = useClock(Boolean(running && !running.data.paused_at));
  const seconds = running ? elapsedSeconds(running.data, now) : 0;
  const target = running
    ? Number(running.data.target_seconds ?? 0)
    : minutes * 60;
  return (
    <>{clockDuration(countdown ? Math.max(0, target - seconds) : seconds)}</>
  );
}
function SessionDuration({ row }: { row: ResourceRecord }) {
  const now = useClock(
    Boolean(row.data.started_at && !row.data.ended_at && !row.data.paused_at),
  );
  return <>{clockDuration(elapsedSeconds(row.data, now))}</>;
}
const timingFields = new Set([
  "item_id",
  "started_at",
  "ended_at",
  "paused_at",
  "paused_ms",
  "target_seconds",
  "kind",
  "metadata",
]);

/** Restores src/pages/track-page.tsx and focus-page.tsx from 5338e49^.
 * Only presentation is adapted; writes still use the durable plugin collections.
 */
export function TrackingView({
  runtime,
  collection,
}: {
  runtime: AppRuntime;
  collection: "track" | "time";
}) {
  const base = getSchema(collection);
  const table = useLiveQuery(
    () => selectedCollectionTable(runtime, collection),
    [runtime, collection],
  );
  const fields = useMemo(
    () => collectionColumns(base, table?.data.columns),
    [base, table],
  );
  const editable = fields.filter(
    (f) => !timingFields.has(f.id) && f.visibility !== "hidden",
  );
  const loadedRows = useLiveQuery(
    async () =>
      base.tables && !table
        ? undefined
        : (await runtime.collection(collection, true).list()).filter((row) =>
            belongsToTable(row, table),
          ),
    [runtime, collection, table?.id],
  );
  const rows = loadedRows ?? [];
  const running = rows.find((r) => r.data.started_at && !r.data.ended_at);
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"start" | "manual" | "preset" | null>(
    null,
  );
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  useEffect(() => {
    setDraft({});
    setDialog(null);
  }, [table?.id, collection]);
  const presets =
    useLiveQuery(
      () =>
        collection === "track"
          ? runtime.collection("presets").list()
          : Promise.resolve([]),
      [runtime, collection],
    ) ?? [];
  const [presetName, setPresetName] = useState("");
  const [kind, setKind] = useState("focus");
  const [minutes, setMinutes] = useState(15);
  const [sound, setSound] = useState("none");
  const [vibration, setVibration] = useState("none");
  const alerts = useLiveQuery(
    () =>
      runtime.db.getMetadata<{ sound: string; vibration: string }>(
        "tracking.alerts",
      ),
    [runtime],
  );
  useEffect(() => {
    if (alerts) {
      setSound(alerts.sound);
      setVibration(alerts.vibration);
    }
  }, [alerts]);
  async function saveAlert(nextSound: string, nextVibration: string) {
    await runtime.db.setMetadata("tracking.alerts", {
      sound: nextSound,
      vibration: nextVibration,
    });
    setSound(nextSound);
    setVibration(nextVibration);
  }
  const writable = runtime.node.records.canWrite();
  const visible = editable;
  const values = running
    ? {
        ...running.data,
        ...((running.data.custom_fields as Record<string, Value>) ?? {}),
      }
    : draft;
  function dataFor(input: Record<string, Value>) {
    const data = { ...initialFieldValues(fields), ...input };
    const custom = { ...((data.custom_fields as Record<string, Value>) ?? {}) };
    for (const f of fields)
      if (f.storage === "custom") {
        custom[f.id] = data[f.id] ?? null;
        delete data[f.id];
      }
    return { ...data, custom_fields: custom };
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      notify.error(error);
    } finally {
      setBusy(false);
    }
  }
  async function start(started = new Date().toISOString(), ended?: string) {
    if (
      !Number.isFinite(Date.parse(started)) ||
      Date.parse(started) > Date.now()
    )
      throw Error("Choose a start time in the past or present.");
    if (
      ended &&
      (!Number.isFinite(Date.parse(ended)) ||
        Date.parse(ended) <= Date.parse(started))
    )
      throw Error("End time must be after start time.");
    if (
      (await runtime.collection(collection).list()).some(
        (r) => r.data.started_at && !r.data.ended_at,
      )
    )
      throw Error("Stop the active session first.");
    if (!ended)
      await prepareTimers(
        collection === "time" && sound.startsWith("indefinite:"),
      );
    const created = await runtime.collection(collection).put(
      dataFor({
        ...draft,
        started_at: started,
        ended_at: ended ?? null,
        ...(collection === "time"
          ? { kind, target_seconds: minutes * 60, paused_ms: "0" }
          : {}),
      }),
    );
    if (!ended) await submitTimer(created);
    setDialog(null);
    setDraft({});
  }
  async function submitTimer(row: ResourceRecord) {
    const tone = (sound.includes(":") ? sound.split(":")[1] : sound) as
      "none" | "chime" | "bell" | "gentle";
    const custom = (row.data.custom_fields as Record<string, Value>) ?? {};
    const titleField = editable.find((f) =>
      ["title", "name", "activity"].includes(f.label.toLowerCase()),
    );
    await runtime.timers.forPlugin(collection).submit({
      id: row.id,
      title: String(
        row.data.title ??
          (titleField && (custom[titleField.id] ?? row.data[titleField.id])) ??
          (collection === "track" ? "Track" : "Time"),
      ),
      startedAt: Date.parse(String(row.data.started_at)),
      durationMs:
        collection === "time"
          ? Number(row.data.target_seconds) * 1000
          : undefined,
      pausedAt: row.data.paused_at
        ? Date.parse(String(row.data.paused_at))
        : undefined,
      pausedMs: Number(row.data.paused_ms ?? 0),
      priority: collection === "time" ? 100 : 10,
      alert: {
        tone,
        repeat: sound.startsWith("indefinite:") ? "indefinite" : "once",
      },
    });
  }
  async function stop(cancelTimer = true) {
    if (!running) return;
    await runtime.collection(collection).put(
      {
        ...running.data,
        ended_at: new Date().toISOString(),
        ...(collection === "time"
          ? {
              paused_at: null,
              paused_ms: String(
                Number(running.data.paused_ms ?? 0) +
                  (running.data.paused_at
                    ? Date.now() - Date.parse(String(running.data.paused_at))
                    : 0),
              ),
            }
          : {}),
      },
      running.id,
    );
    if (cancelTimer)
      await runtime.timers.forPlugin(collection).remove(running.id);
  }
  async function pause() {
    if (!running) return;
    const paused = running.data.paused_at;
    const updated = await runtime.collection(collection).put(
      {
        ...running.data,
        paused_at: paused ? null : new Date().toISOString(),
        paused_ms: String(
          Number(running.data.paused_ms ?? 0) +
            (paused ? Date.now() - Date.parse(String(paused)) : 0),
        ),
      },
      running.id,
    );
    await submitTimer(updated);
  }
  const form = (
    list: Field[],
    data: Record<string, Value>,
    change: (value: Record<string, Value>) => void,
  ) => (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.map((f) => (
        <label key={f.id} className="grid gap-2 text-sm">
          <span>{f.label}</span>
          <FieldInput
            definition={f}
            value={data[f.id]}
            disabled={!writable || busy || f.visibility === "viewable"}
            onChange={(value) => change({ ...data, [f.id]: value })}
          />
        </label>
      ))}
    </div>
  );
  if (base.tables && !table) return <LoadingSpinner label="Opening table…" />;
  if (loadedRows === undefined)
    return <LoadingSpinner label="Loading sessions…" />;
  return (
    <div className="grid w-full gap-6">
      <Card className="overflow-visible rounded-none bg-transparent py-0 ring-0">
        <CardHeader className="flex flex-col gap-4 px-0 md:flex-row md:justify-between">
          <CardTitle>{collection === "track" ? "Session" : "Focus"}</CardTitle>
          <div className="flex flex-wrap gap-2">
            {collection === "track" && (
              <>
                <ChoiceSelect
                  className="w-40"
                  aria-label="Session presets"
                  placeholder="Presets"
                  disabled={!!running || busy}
                  value=""
                  options={presets.map((p) => ({
                    value: p.id,
                    label: String(p.data.name),
                  }))}
                  onValueChange={(id) => {
                    const preset = presets.find((p) => p.id === id);
                    if (preset)
                      setDraft(
                        (preset.data.values as Record<string, Value>) ?? {},
                      );
                  }}
                />
                <Button
                  variant="outline"
                  disabled={!!running || busy || !writable}
                  onClick={() => setDialog("preset")}
                >
                  Save preset
                </Button>
              </>
            )}
            {collection === "time" && (
              <Button
                variant="outline"
                disabled={!writable || busy}
                onClick={() =>
                  void action(async () => {
                    if (running) await stop();
                  })
                }
              >
                Reset
              </Button>
            )}
            {collection === "track" && (
              <>
                <Button
                  variant="secondary"
                  disabled={!writable || busy || !!running}
                  onClick={() => {
                    setStartAt("");
                    setDialog("start");
                  }}
                >
                  Start At
                </Button>
                <Button
                  variant="outline"
                  disabled={!writable || busy || !!running}
                  onClick={() => {
                    setStartAt("");
                    setEndAt("");
                    setDialog("manual");
                  }}
                >
                  Manual
                </Button>
              </>
            )}
            {running && collection === "time" && (
              <Button
                variant="outline"
                disabled={!writable || busy}
                onClick={() => void action(pause)}
              >
                {running.data.paused_at ? "Resume" : "Pause"}
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={
                !writable ||
                busy ||
                (collection === "time" &&
                  !running &&
                  (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440))
              }
              onClick={() =>
                void action(running ? () => stop() : () => start())
              }
            >
              {running ? "Stop Session" : "Start"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 px-0">
          <div className="flex items-center gap-4">
            <div
              className="text-5xl font-semibold tracking-tight md:text-6xl"
              role="timer"
            >
              <SessionClock
                running={running}
                minutes={minutes}
                countdown={collection === "time"}
              />
            </div>
            <div className="rounded-full border px-4 py-2 text-sm text-muted-foreground">
              {running
                ? running.data.paused_at
                  ? "Paused"
                  : "Running"
                : "Stopped"}
            </div>
          </div>
          {collection === "time" && (
            <>
              <div className="flex flex-wrap gap-2">
                {[1, 5, 15, 30].map((n) => (
                  <Button
                    key={n}
                    variant={minutes === n ? "default" : "outline"}
                    disabled={!!running}
                    onClick={() => setMinutes(n)}
                  >
                    {n}
                  </Button>
                ))}
                <Input
                  className="w-28"
                  type="number"
                  min={1}
                  max={1440}
                  aria-label="Custom minutes"
                  disabled={!!running}
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm">
                  Complete Alert Sound
                  <ChoiceSelect
                    aria-label="Complete Alert Sound"
                    value={
                      sound === "none" || sound.includes(":")
                        ? sound
                        : "once:" + sound
                    }
                    disabled={busy}
                    onValueChange={(value) =>
                      void action(() => saveAlert(value, vibration))
                    }
                    options={[
                      { value: "none", label: "None", group: "Once" },
                      ...["chime", "bell", "gentle"].map((tone) => ({
                        value: "once:" + tone,
                        label: tone[0].toUpperCase() + tone.slice(1),
                        group: "Once",
                      })),
                      ...["chime", "bell", "gentle"].map((tone) => ({
                        value: "indefinite:" + tone,
                        label:
                          tone[0].toUpperCase() +
                          tone.slice(1) +
                          " until stopped",
                        group: "Indefinite",
                      })),
                    ]}
                  />
                </label>
                <label className="grid gap-2 text-sm">
                  Vibrate
                  <ChoiceSelect
                    aria-label="Vibrate"
                    value={vibration}
                    disabled={busy}
                    onValueChange={(value) =>
                      void action(() => saveAlert(sound, value))
                    }
                    options={["none", "short", "pulse"].map((value) => ({
                      value,
                      label: value[0].toUpperCase() + value.slice(1),
                    }))}
                  />
                </label>
              </div>
              <div className="flex gap-2">
                {["focus", "break"].map((k) => (
                  <Button
                    key={k}
                    disabled={!!running}
                    variant={kind === k ? "default" : "outline"}
                    onClick={() => setKind(k)}
                  >
                    {k === "focus" ? "Focus" : "Break"}
                  </Button>
                ))}
              </div>
            </>
          )}
          <section className="grid gap-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              Session Fields
            </h3>
            {form(visible, values, (next) => {
              if (running)
                void action(() =>
                  runtime.collection(collection).put(dataFor(next), running.id),
                );
              else setDraft(next);
            })}
          </section>
        </CardContent>
      </Card>
      <Entries
        runtime={runtime}
        collection={collection}
        rows={rows}
        fields={fields}
      />
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === "preset"
                ? "Save session preset"
                : dialog === "manual"
                  ? "Manual Entry"
                  : "Start At"}
            </DialogTitle>
          </DialogHeader>
          {dialog === "preset" ? (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await runtime
                    .collection("presets")
                    .put({ name: presetName.trim(), values: draft });
                  setPresetName("");
                  setDialog(null);
                });
              }}
            >
              <label>
                Preset name
                <Input
                  required
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
              </label>
              <Button disabled={busy || !presetName.trim()}>Save preset</Button>
            </form>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void action(() =>
                  start(
                    new Date(startAt).toISOString(),
                    dialog === "manual"
                      ? new Date(endAt).toISOString()
                      : undefined,
                  ),
                );
              }}
            >
              <label className="grid gap-2">
                Start Time
                <Input
                  type="datetime-local"
                  required
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              </label>
              {dialog === "manual" && (
                <>
                  <label className="grid gap-2">
                    End Time
                    <Input
                      type="datetime-local"
                      required
                      value={endAt}
                      onChange={(e) => setEndAt(e.target.value)}
                    />
                  </label>
                  {form(visible, draft, setDraft)}
                </>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </Button>
                <Button disabled={!writable || busy}>
                  {dialog === "manual" ? "Save Entry" : "Start"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const Entries = memo(function Entries({
  runtime,
  collection,
  rows,
  fields,
}: {
  runtime: AppRuntime;
  collection: string;
  rows: ResourceRecord[];
  fields: Field[];
}) {
  const [entry, setEntry] = useState<ResourceRecord | null>(null);
  let durationId = "session_duration";
  while (fields.some((f) => f.id === durationId)) durationId += "_";
  const displayRows = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        data: {
          ...r.data,
          ...((r.data.custom_fields as Record<string, Value>) ?? {}),
          [durationId]: clockDuration(elapsedSeconds(r.data, Date.now())),
        },
      })),
    [rows, durationId],
  );
  const schema = useMemo(
    () => ({
      ...getSchema(collection),
      fields: [
        {
          ...getSchema(collection).fields.find((f) => f.id === "started_at")!,
          label: "Start",
        },
        {
          ...getSchema(collection).fields.find((f) => f.id === "ended_at")!,
          label: "End",
        },
        field(durationId, "Duration", "text", { visibility: "viewable" }),
        ...fields.filter((f) => !timingFields.has(f.id)),
      ],
    }),
    [collection, fields, durationId],
  );
  const store = useMemo(
    () => ({
      list: async () => displayRows,
      put: async (input: Record<string, Value>, id?: string) => {
        const old = rows.find((r) => r.id === id);
        const data = { ...old?.data, ...input };
        delete data[durationId];
        const custom = {
          ...((old?.data.custom_fields as Record<string, Value>) ?? {}),
        };
        for (const f of fields)
          if (
            f.storage === "custom" ||
            !getSchema(collection).fields.some((base) => base.id === f.id)
          ) {
            custom[f.id] = input[f.id] ?? null;
            delete data[f.id];
          }
        return runtime
          .collection(collection)
          .put({ ...data, custom_fields: custom }, id);
      },
      delete: (id: string) => runtime.collection(collection).delete(id),
    }),
    [runtime, collection, rows, fields, displayRows, durationId],
  );
  return (
    <Card className="overflow-visible rounded-none bg-transparent py-0 ring-0">
      <CardHeader className="flex flex-col gap-4 px-0 md:flex-row md:justify-between">
        <div className="space-y-1">
          <CardTitle>Entries</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 px-0">
        <RecordTable
          runtime={runtime}
          collection={collection}
          storeOverride={store}
          rowsOverride={displayRows}
          renderCell={({ row, field, defaultContent }) => {
            if (
              field.id !== durationId ||
              !row.data.started_at ||
              row.data.ended_at ||
              row.data.paused_at
            )
              return defaultContent;
            const clock = <SessionDuration row={row} />;
            return isValidElement<{ children?: ReactNode }>(defaultContent)
              ? cloneElement(defaultContent, {}, clock)
              : clock;
          }}
          hideCreate
          defaultView={{ mode: "list" }}
          onOpen={(row) =>
            setEntry(rows.find((saved) => saved.id === row.id) ?? row)
          }
          viewKey={`tracking.entries.${collection}`}
          schemaOverride={schema}
        />
      </CardContent>
      <Dialog open={!!entry} onOpenChange={(open) => !open && setEntry(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Edit Entry</DialogTitle>
          </DialogHeader>
          {entry && runtime.node.records.canWrite() && (
            <RecordForm
              key={entry.id}
              schema={{
                ...getSchema(collection),
                fields: [
                  ...getSchema(collection).fields.filter((f) =>
                    ["started_at", "ended_at"].includes(f.id),
                  ),
                  ...fields.filter((f) => !timingFields.has(f.id)),
                ],
              }}
              initial={{
                ...entry.data,
                ...((entry.data.custom_fields as Record<string, Value>) ?? {}),
              }}
              onCancel={() => setEntry(null)}
              onSave={async (input) => {
                const custom = {
                  ...((entry.data.custom_fields as Record<string, Value>) ??
                    {}),
                };
                const data = { ...entry.data, ...input };
                for (const f of fields)
                  if (f.storage === "custom") {
                    custom[f.id] = input[f.id] ?? null;
                    delete data[f.id];
                  }
                await runtime
                  .collection(collection)
                  .put({ ...data, custom_fields: custom }, entry.id);
                setEntry(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
});
