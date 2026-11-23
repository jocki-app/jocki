import { useEffect, useState } from "react";
import type { DatabaseWorkingStorage } from "../storage/database";
import { ChoiceSelect } from "../ui/choice-select";
import { notify } from "../ui/notifications";
import "./network";

export function DatabaseSettings() {
  const api = window.jockiNative?.database;
  const [mode, setMode] = useState<DatabaseWorkingStorage>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .settings()
      .then((value) => {
        if (active) setMode(value);
      })
      .catch((error) => notify.error(error));
    return () => {
      active = false;
    };
  }, [api]);
  if (!api) return null;
  return (
    <section className="settings-card space-y-3">
      <h2>Local query storage</h2>
      <label className="field-row">
        Working storage
        <ChoiceSelect
          aria-label="Local query working storage"
          value={mode}
          placeholder="Loading…"
          disabled={!mode || busy}
          options={[
            { value: "disk", label: "Disk (default)" },
            { value: "memory", label: "Memory" },
          ]}
          onValueChange={(value) => {
            if (value !== "disk" && value !== "memory") return;
            setBusy(true);
            void api
              .configure(value)
              .then((saved) => {
                setMode(saved);
                notify.success(
                  "Storage saved. Reopen this workspace to apply.",
                );
              })
              .catch((error) => notify.error(error))
              .finally(() => setBusy(false));
          }}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Choose disk or memory for SQL queries. Reopen the workspace to apply.
        Automerge Repo manages document persistence separately.
      </p>
    </section>
  );
}
