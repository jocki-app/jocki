import { useState, useMemo, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  defaultCSDBImportSettings,
  readCSDBImportSettings,
  validateCSDBImportSettings,
  csdbMergeParts,
  type CSDBImportProfile,
} from "../core/vaults/csdb-import";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import { updatePluginPreferences } from "./vault-template-settings";
import { useReportedError } from "./errors";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { Switch } from "../ui/primitives/switch";
import { ChoiceSelect } from "../ui/choice-select";
export function CSDBSettings({
  runtime,
  changed,
}: {
  runtime: VaultRuntime;
  changed(): void;
}) {
  const [, report] = useReportedError("csdb-settings");
  const initial = useMemo(() => {
    try {
      return {
        settings: readCSDBImportSettings(
          runtime.workspace.settings(runtime.computer).plugins["core.csdb"],
        ),
      };
    } catch (error) {
      return { settings: defaultCSDBImportSettings(), error };
    }
  }, []);
  const [settings, setSettings] = useState(initial.settings);
  useEffect(() => {
    if (initial.error) report(initial.error);
  }, [initial, report]);
  const [selected, setSelected] = useState(settings.default_profile),
    [busy, setBusy] = useState(false);
  const profile =
    settings.profiles.find((profile) => profile.id === selected) ??
    settings.profiles[0];
  const [selectorText, setSelectorText] = useState<Record<string, string>>({});
  const selectors =
    selectorText[profile.id] ??
    JSON.stringify(profile.options.tables ?? [], null, 2);
  const patch = (patch: Partial<CSDBImportProfile>) =>
    setSettings((settings) => ({
      ...settings,
      profiles: settings.profiles.map((p) =>
        p.id === profile.id ? { ...p, ...patch } : p,
      ),
    }));
  const save = async () => {
    setBusy(true);
    try {
      const next = validateCSDBImportSettings({
        ...settings,
        profiles: settings.profiles.map((p) => {
          const tables = JSON.parse(
            selectorText[p.id] ?? JSON.stringify(p.options.tables ?? []),
          );
          if (!Array.isArray(tables))
            throw Error("Table selection must be a JSON array");
          const options = { ...p.options };
          if (tables.length) options.tables = tables;
          else delete options.tables;
          return { ...p, options };
        }),
      });
      await updatePluginPreferences(runtime, "core.csdb", {
        configuration: next as unknown as Record<string, unknown>,
      });
      setSettings(next);
      changed();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-5" data-csdb-settings>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          Import profile
          <ChoiceSelect
            aria-label="Import profile"
            value={profile.id}
            options={settings.profiles.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            onValueChange={(id) => {
              setSelected(id);
            }}
          />
        </label>
        <Button
          variant="outline"
          onClick={() => {
            const id = crypto.randomUUID();
            setSettings((s) => ({
              ...s,
              profiles: [
                ...s.profiles,
                { ...structuredClone(profile), id, name: "New profile" },
              ],
            }));
            setSelected(id);
          }}
        >
          <Plus />
          Add profile
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete import profile"
          disabled={settings.profiles.length < 2}
          onClick={() => {
            const next = settings.profiles.filter((p) => p.id !== profile.id);
            setSettings((s) => ({
              ...s,
              profiles: next,
              default_profile:
                s.default_profile === profile.id
                  ? next[0].id
                  : s.default_profile,
            }));
            setSelected(next[0].id);
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          Name
          <Input
            aria-label="Profile name"
            value={profile.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          Default profile
          <ChoiceSelect
            aria-label="Default merge profile"
            value={settings.default_profile}
            options={settings.profiles.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            onValueChange={(id) =>
              setSettings((s) => ({ ...s, default_profile: id }))
            }
          />
        </label>
        <label className="space-y-1 text-sm">
          After import
          <ChoiceSelect
            aria-label="Import presentation"
            value={profile.view}
            options={[
              { value: "table", label: "Data table draft" },
              { value: "form", label: "Attribute form draft" },
              { value: "autosave", label: "Save automatically" },
            ]}
            onValueChange={(view) =>
              patch({ view: view as CSDBImportProfile["view"] })
            }
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={profile.map_single_table}
            onCheckedChange={(map_single_table) => patch({ map_single_table })}
          />
          Match single source and destination tables
        </label>
        {(
          [
            [
              "conflicts",
              "Row conflicts",
              ["error", "skip", "update", "replace"],
            ],
            [
              "metadata_conflicts",
              "Definition conflicts",
              ["error", "source", "target"],
            ],
            ["nulls", "Blank imported values", ["preserve", "defaults"]],
            ["missing_tables", "Missing tables", ["error", "create", "skip"]],
            ["missing_columns", "Missing columns", ["error", "add", "ignore"]],
            [
              "missing_foreign_keys",
              "Unresolved foreign keys",
              ["error", "drop", "null"],
            ],
          ] as const
        ).map(([key, label, values]) => (
          <label key={key} className="space-y-1 text-sm">
            {label}
            <ChoiceSelect
              aria-label={label}
              value={profile.options[key] ?? values[0]}
              options={values.map((value) => ({ value, label: value }))}
              onValueChange={(value) =>
                patch({ options: { ...profile.options, [key]: value } })
              }
            />
          </label>
        ))}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Transfer</legend>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {csdbMergeParts.map((part) => (
            <label key={part} className="flex items-center gap-2 text-sm">
              <Switch
                checked={(profile.options.include ?? ["data"]).includes(part)}
                onCheckedChange={(enabled) =>
                  patch({
                    options: {
                      ...profile.options,
                      include: enabled
                        ? [...(profile.options.include ?? ["data"]), part]
                        : (profile.options.include ?? ["data"]).filter(
                            (value) => value !== part,
                          ),
                    },
                  })
                }
              />
              {part.replaceAll("_", " ")}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-2 text-sm">
        Table, row and column selection (JSON)
        <Textarea
          aria-label="Merge selection"
          className="min-h-32 font-mono text-xs"
          value={selectors}
          onChange={(e) =>
            setSelectorText((previous) => ({
              ...previous,
              [profile.id]: e.target.value,
            }))
          }
        />
        <span className="block text-xs text-muted-foreground">
          Leave [] to use all tables. Entries accept source, target, columns and
          rows (indices, keys or a CSDB expression). A single table mapping
          takes precedence over automatic matching.
        </span>
      </label>
      {profile.view === "autosave" && (
        <p className="text-sm text-muted-foreground">
          Imports save directly to the destination. Open drafts with unsaved
          changes must be saved or discarded first.
        </p>
      )}
      <Button disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save import profiles"}
      </Button>
    </section>
  );
}
