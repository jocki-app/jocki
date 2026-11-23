import { WorkspaceIcon } from "./workspace-icon";
import { useEffect, useState, type ReactNode } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { LocalLogRecord } from "../core/local-logs";
import { logRetentionDays } from "../core/local-logs";
import { filePatternMatcher } from "../platform/src/file-sdk/file-patterns";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { ChoiceSelect } from "../ui/choice-select";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import { ExtensionConfiguration } from "./vault-extension-contributions";
import {
  updatePluginPreferences,
  type PluginFilePreferences,
} from "./vault-template-settings";
import { useReportedError } from "./errors";

export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6"
      data-settings-page={title}
    >
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {title === "Workspace" && (
            <WorkspaceIcon className="size-5 shrink-0" />
          )}
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}
export function PluginSettingsPage({
  runtime,
  plugin,
  target,
  changed,
  onTarget,
}: {
  runtime: VaultRuntime;
  plugin: string;
  target: string;
  changed(): void;
  onTarget?(value: string): void;
}) {
  const manifest = runtime.extensions
    .installed()
    .find((item) => item.manifest.id === plugin)?.manifest;
  if (!manifest)
    return (
      <SettingsPage title="Plugin unavailable">
        <p>This plugin is no longer installed.</p>
      </SettingsPage>
    );
  const settings = runtime.extensions
    .configurationContributions()
    .filter((item) => item.extension === plugin);
  return (
    <SettingsPage title={manifest.name} description={manifest.description}>
      <p className="text-xs text-muted-foreground">
        {plugin} · {manifest.version}
      </p>
      <p className="text-sm">
        Supported MIME types: {manifest.mimeTypes.join(", ")}
      </p>
      {!!manifest.contentTypes.length && (
        <p className="text-sm">
          Content types: {manifest.contentTypes.join(", ")}
        </p>
      )}
      {!!settings.length && (
        <>
          {onTarget && (
            <label className="block space-y-2">
              Edit settings for
              <ChoiceSelect
                aria-label="Plugin settings target"
                value={target}
                onValueChange={onTarget}
                options={[
                  { value: "defaults", label: "Defaults" },
                  ...Object.keys(runtime.workspace.current.computers).map(
                    (id) => ({
                      value: id,
                      label: id === runtime.computer ? "This computer" : id,
                    }),
                  ),
                ]}
              />
            </label>
          )}
          <ExtensionConfiguration
            runtime={runtime}
            extension={plugin}
            target={target}
            changed={changed}
          />
        </>
      )}
      {!settings.length && (
        <p className="text-sm text-muted-foreground">
          This plugin has no additional settings.
        </p>
      )}
    </SettingsPage>
  );
}
export function LogsPage({ runtime }: { runtime: Pick<VaultRuntime, "logs"> }) {
  const [records, setRecords] = useState<LocalLogRecord[]>([]),
    [query, setQuery] = useState(""),
    [level, setLevel] = useState("");
  const [, report] = useReportedError("logs");
  const reload = () => {
    void runtime.logs.list().then(setRecords).catch(report);
  };
  useEffect(() => {
    reload();
    const remove = runtime.logs.subscribe(() => reload());
    return remove;
  }, [runtime]);
  const filtered = records.filter(
    (r) =>
      (!level || r.level === level) &&
      `${r.category} ${r.message}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <SettingsPage
      title="Local logs"
      description={`Logs stay on this computer and expire after ${logRetentionDays} days. Each day's log is capped at 2 MiB.`}
    >
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-48 flex-1"
          aria-label="Search logs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search logs"
        />
        <ChoiceSelect
          aria-label="Log level"
          value={level}
          onValueChange={setLevel}
          options={[
            { value: "", label: "All levels" },
            ...["debug", "info", "warning", "error", "fatal"].map((value) => ({
              value,
              label: value,
            })),
          ]}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh logs"
          onClick={reload}
        >
          <RefreshCw />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Export logs"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([filtered.map((r) => JSON.stringify(r)).join("\n")], {
                type: "application/x-ndjson",
              }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = "jocki-logs.jsonl";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Clear logs"
          onClick={() => {
            void runtime.logs.clear().then(reload).catch(report);
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Level</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.slice(0, 1000).map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap align-top">
                {new Date(r.time).toLocaleString()}
              </TableCell>
              <TableCell className="align-top">{r.level}</TableCell>
              <TableCell className="align-top">{r.category}</TableCell>
              <TableCell>
                <pre className="max-w-2xl whitespace-pre-wrap break-words text-xs">
                  {r.message}
                </pre>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!filtered.length && (
        <p className="text-muted-foreground">No matching logs.</p>
      )}
    </SettingsPage>
  );
}
