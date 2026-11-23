import { ErrorToast, useReportedError } from "./errors";
import { useEffect, useRef, useState } from "react";
import {
  Download,
  Info,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import {
  readFileExtensionInventory,
  type FileExtensionInventory,
} from "../platform/src/file-sdk/inventory";
import { boundedDownload } from "../platform/src/plugin-sdk/inventory";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { Badge } from "../ui/primitives/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/primitives/dialog";
import {
  updatePluginPreferences,
  type PluginFilePreferences,
} from "./vault-template-settings";

/** Same inventory/install table and details flow as the original plugin screen. */
export function FilePluginSettings({
  runtime,
  changed,
  target = "defaults",
  onSettings,
  heading = true,
}: {
  runtime: VaultRuntime;
  changed(): void;
  target?: string;
  onSettings?(plugin: string): void;
  heading?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [url, setURL] = useState(() =>
      String(
        (
          runtime.workspace.settings(runtime.computer).plugins[
            "core.extensions"
          ] as PluginFilePreferences | undefined
        )?.configuration?.source ?? "",
      ),
    ),
    [inventory, setInventory] = useState<FileExtensionInventory>(),
    [sources, setSources] = useState(false),
    [upload, setUpload] = useState(false),
    [selected, setSelected] = useState<string>(),
    [publisher, setPublisher] = useState(""),
    [publicKey, setPublicKey] = useState(""),
    [error, setError] = useReportedError("vault-plugin-settings"),
    [busy, setBusy] = useState(false);
  const settings = (
    target === "defaults"
      ? runtime.workspace.current.defaults
      : runtime.workspace.settings(target)
  ).plugins;
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      changed();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!url) return;
    let live = true;
    setBusy(true);
    void readFileExtensionInventory(url)
      .then((value) => {
        if (live) setInventory(value);
      })
      .catch((error) => {
        if (live) setError(error);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const installed = runtime.extensions.installed(),
    entries = new Map((inventory?.extensions ?? []).map((e) => [e.id, e])),
    ids = [
      ...new Set([...installed.map((e) => e.manifest.id), ...entries.keys()]),
    ].filter((id) => {
      const e =
        installed.find((e) => e.manifest.id === id)?.manifest ??
        entries.get(id);
      return (e?.name + " " + e?.description)
        .toLowerCase()
        .includes(query.toLowerCase());
    });
  const current = installed.find((e) => e.manifest.id === selected),
    detail =
      current?.manifest ?? (selected ? entries.get(selected) : undefined);
  const install = (id: string) =>
    run(async () => {
      const entry = entries.get(id)!;
      await runtime.installExtension(
        await boundedDownload(entry.downloadUrl, 50 * 1024 * 1024, {
          followRedirects: true,
        }),
        inventory!.publishers,
        entry,
      );
    });
  return (
    <section className="space-y-4" data-plugin-manager>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading && <h2 className="text-lg font-semibold">Plugins</h2>}
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Plugin sources"
            title="Plugin sources"
            onClick={() => setSources(true)}
          >
            <Settings />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Install a signed ZIP"
            title="Install a signed ZIP"
            onClick={() => setUpload(true)}
          >
            <Upload />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh plugin inventory"
            disabled={!url || busy}
            onClick={() =>
              void run(async () =>
                setInventory(await readFileExtensionInventory(url)),
              )
            }
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Search className="size-4 text-muted-foreground" />
        <Input
          aria-label="Find plugins"
          placeholder="Search plugins…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Manage</TableHead>
            <TableHead>Plugin</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="hidden w-20 sm:table-cell">Version</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Details</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ids.map((id) => {
            const state = installed.find((e) => e.manifest.id === id),
              manifest = state?.manifest ?? entries.get(id)!,
              enabled =
                (settings[id] as { enabled?: boolean } | undefined)?.enabled !==
                false,
              Icon = !state ? Download : enabled ? Pause : Play;
            return (
              <TableRow key={id}>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant={!state ? "default" : "outline"}
                      size="icon-sm"
                      aria-label={`${!state ? "Install" : enabled ? "Disable" : "Enable"} ${manifest.name}`}
                      disabled={busy}
                      onClick={() =>
                        void (state
                          ? run(() =>
                              runtime.setExtensionEnabled(id, !enabled, target),
                            )
                          : install(id))
                      }
                    >
                      <Icon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Uninstall ${manifest.name}`}
                      disabled={!state || state.builtin || busy}
                      onClick={() =>
                        void run(() => runtime.removeExtension(id))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="font-medium">{manifest.name}</span>
                  <p className="truncate text-xs text-muted-foreground">
                    {manifest.description}
                  </p>
                  {state?.error && (
                    <ErrorToast error={state.error} source="plugin" />
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {!state ? "Available" : enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {manifest.version}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Details for ${manifest.name}`}
                    onClick={() =>
                      state && onSettings ? onSettings(id) : setSelected(id)
                    }
                  >
                    <Info />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {runtime.packages
        .list()
        .filter((pkg) => !installed.some((e) => e.manifest.id === pkg.id))
        .map((pkg) => (
          <p key={pkg.id}>
            {pkg.id}:{" "}
            <ErrorToast
              error={
                runtime.extensions.failures.get(pkg.id) ?? "Package unavailable"
              }
              source="plugin"
            />{" "}
            Package unavailable
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${pkg.id}`}
              onClick={() => void run(() => runtime.removeExtension(pkg.id))}
            >
              <Trash2 />
            </Button>
          </p>
        ))}
      {busy && <p role="status">Verifying plugin…</p>}

      <Dialog open={sources} onOpenChange={setSources}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plugin sources</DialogTitle>
            <DialogDescription>
              Add a signed inventory to browse available plugins.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setInventory(await readFileExtensionInventory(url));
                await updatePluginPreferences(runtime, "core.extensions", {
                  configuration: { source: url },
                });
                setSources(false);
              });
            }}
          >
            <label className="space-y-1">
              Inventory URL
              <Input
                type="url"
                value={url}
                onChange={(e) => setURL(e.target.value)}
                required
              />
            </label>
            <Button type="submit" disabled={busy}>
              <Plus />
              Read source
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={upload} onOpenChange={setUpload}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install a signed ZIP</DialogTitle>
            <DialogDescription>
              Verify the package with a trusted publisher key.
            </DialogDescription>
          </DialogHeader>
          <label>
            Publisher ID
            <Input
              value={publisher}
              onChange={(e) => setPublisher(e.target.value)}
            />
          </label>
          <label>
            Trusted publisher public key (PEM)
            <Textarea
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
            />
          </label>
          <label>
            Package
            <Input
              type="file"
              accept=".zip"
              disabled={busy || !publisher || !publicKey}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void run(async () => {
                    await runtime.installExtension(
                      new Uint8Array(await file.arrayBuffer()),
                      { [publisher]: publicKey },
                    );
                    setUpload(false);
                  });
              }}
            />
          </label>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail?.name ?? "Plugin"}</DialogTitle>
            <DialogDescription>
              {detail?.description || "Plugin settings and file matching."}
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <>
              <p className="text-xs text-muted-foreground">
                {selected} · {detail?.version} · {detail?.publisher}
              </p>
              <p className="text-sm">
                Supported MIME types: {current?.manifest.mimeTypes.join(", ")}
              </p>
              {!!current?.manifest.contentTypes.length && (
                <p className="text-sm">
                  Content types: {current.manifest.contentTypes.join(", ")}
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
