import { useEffect, useRef, useState } from "react";
import {
  Download,
  Info,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import { isRequiredCore } from "@jocki/platform/core/catalog";
import { field } from "@jocki/platform/field-types";
import type { PluginManifest } from "@jocki/platform/plugin-sdk";
import {
  comparePluginVersions,
  type InventoryEntry,
} from "@jocki/platform/plugin-sdk/inventory";
import { useLiveQuery } from "../data-duckdb/react";
import { notify } from "../ui/notifications";
import { LoadingSpinner } from "../ui/loading-spinner";
import { FieldInput } from "../ui/fields";
import { Badge } from "../ui/primitives/badge";
import { Button } from "../ui/primitives/button";
import { ButtonGroup } from "../ui/primitives/button-group";
import { Input } from "../ui/primitives/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/primitives/input-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/primitives/table";
import type { AppRuntime } from "./runtime";

type ListedPlugin = Pick<
  PluginManifest,
  | "id"
  | "name"
  | "description"
  | "version"
  | "publisher"
  | "license"
  | "dependencies"
  | "features"
  | "permissions"
>;

export function PluginsView({ runtime }: { runtime: AppRuntime }) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [details, setDetails] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const states =
    useLiveQuery(() => runtime.db.plugins.toArray(), [runtime]) ?? [];
  const pluginFailures = JSON.stringify(
    states
      .filter((state) => state.error)
      .map((state) => [state.id, state.error]),
  );
  useEffect(() => {
    for (const [id, message] of JSON.parse(pluginFailures))
      notify.error(`${id}: ${message}`);
  }, [pluginFailures]);
  useEffect(() => {
    if (runtime.inventoryError)
      notify.warning(
        runtime.inventoryError + ". Installed plugins remain available.",
      );
  }, [runtime.inventoryError]);

  const entries = new Map(
    runtime.availablePlugins.map((entry) => [entry.id, entry]),
  );
  const plugins = new Map<string, ListedPlugin>(runtime.registry.manifests);
  for (const entry of runtime.availablePlugins)
    if (!plugins.has(entry.id))
      plugins.set(entry.id, { ...entry, features: {} });
  const query = search.trim().toLocaleLowerCase();
  const visible = [...plugins.values()].filter((plugin) =>
    `${plugin.name}\n${plugin.description}`.toLocaleLowerCase().includes(query),
  );
  const writable = runtime.node.records.canWrite();
  const selected = details ? plugins.get(details) : undefined;
  const selectedDownload = details ? entries.get(details) : undefined;
  const selectedEntry =
    selectedDownload?.version === selected?.version
      ? selectedDownload
      : undefined;
  const selectedState = states.find((state) => state.id === details);
  const updateAvailable =
    selected &&
    !isRequiredCore(selected.id) &&
    selectedState?.installed &&
    selectedDownload &&
    comparePluginVersions(selectedDownload.version, selectedState.version) > 0;

  async function work(id: string, action: () => Promise<void>) {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      notify.error(error);
    } finally {
      setBusy("");
    }
  }
  function action(
    id: string,
    kind: "install" | "disable" | "enable" | "uninstall",
  ) {
    return work(id, async () => {
      if (kind === "install") await runtime.installAndEnable(id);
      else await runtime.pluginAction(id, kind);
      notify.success(
        `Plugin ${kind === "install" ? "installed" : kind === "enable" ? "enabled" : kind === "disable" ? "disabled" : "uninstalled"}.`,
      );
    });
  }
  function table(required: boolean) {
    const rows = visible.filter(
      (plugin) => isRequiredCore(plugin.id) === required,
    );
    return (
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
          {rows.map((plugin) => {
            const state = states.find((state) => state.id === plugin.id);
            const installed = required || state?.installed;
            const enabled = required || state?.enabled;
            const kind = !installed
              ? "install"
              : enabled
                ? "disable"
                : "enable";
            const label = !installed
              ? "Install"
              : enabled
                ? "Disable"
                : "Enable";
            const Icon = !installed ? Download : enabled ? Pause : Play;
            return (
              <TableRow key={plugin.id}>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon-sm"
                      variant={installed ? "outline" : "default"}
                      aria-label={label}
                      title={required ? "Required by core" : label}
                      disabled={required || Boolean(busy) || !writable}
                      onClick={() => void action(plugin.id, kind)}
                    >
                      {busy === plugin.id ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Icon />
                      )}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Uninstall"
                      title={required ? "Required by core" : "Uninstall"}
                      disabled={
                        required || !installed || Boolean(busy) || !writable
                      }
                      onClick={() => void action(plugin.id, "uninstall")}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="break-words whitespace-normal font-medium">
                    {plugin.name}
                  </div>
                  <div className="mt-1 max-w-lg break-words whitespace-normal text-xs text-muted-foreground">
                    {plugin.description}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={enabled ? "secondary" : "outline"}>
                    {required
                      ? "Required"
                      : enabled
                        ? "Enabled"
                        : installed
                          ? "Disabled"
                          : "Not installed"}
                  </Badge>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                  {state?.installed ? state.version : plugin.version}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Package details and permissions"
                    title="Package details and permissions"
                    onClick={() => setDetails(plugin.id)}
                  >
                    <Info />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {!rows.length && (
            <TableRow>
              <TableCell
                colSpan={5}
                className="py-8 text-center text-muted-foreground"
              >
                {query
                  ? "No plugins match your search."
                  : "No plugins available."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    );
  }
  return (
    <div className="space-y-8">
      <section aria-label="Plugins">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <InputGroup className="w-full sm:max-w-sm">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search plugins"
              placeholder="Search plugins…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ButtonGroup aria-label="Plugin inventory">
              <Button
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() =>
                  void work("sync", async () => {
                    await runtime.refreshInventory();
                    if (runtime.inventoryError)
                      notify.warning(runtime.inventoryError);
                    else notify.success("Plugin list synced.");
                  })
                }
              >
                <RefreshCw
                  className={busy === "sync" ? "animate-spin" : undefined}
                />
                Sync
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Plugin sources"
                title="Plugin sources"
                disabled={Boolean(busy)}
                onClick={() => {
                  setSources([...runtime.inventoryUrls]);
                  setSourcesOpen(true);
                }}
              >
                <Settings />
              </Button>
            </ButtonGroup>
            <Button
              variant="outline"
              disabled={Boolean(busy) || !writable}
              onClick={() => fileInput.current?.click()}
            >
              <Upload />
              {busy === "import" ? "Importing…" : "Import"}
            </Button>
            <Input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              aria-label="Import plugin package"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void work("import", async () => {
                  if (file.size > 50 * 1024 * 1024)
                    throw Error("Plugin package exceeds 50 MB");
                  const manifest = await runtime.importPlugin(
                    new Uint8Array(await file.arrayBuffer()),
                  );
                  notify.success(`${manifest.name} imported and installed.`);
                });
              }}
            />
            <span className="ml-1 whitespace-nowrap text-sm text-muted-foreground">
              {visible.filter((plugin) => !isRequiredCore(plugin.id)).length}{" "}
              plugins
            </span>
          </div>
        </div>
        {runtime.inventoryPending ? (
          <LoadingSpinner label="Loading plugins…" />
        ) : (
          table(false)
        )}
      </section>
      <section aria-label="Required core">
        <div className="section-heading">
          <h2>Required core</h2>
          <span>
            {visible.filter((plugin) => isRequiredCore(plugin.id)).length}{" "}
            plugins
          </span>
        </div>
        {table(true)}
      </section>
      <Dialog
        open={sourcesOpen}
        onOpenChange={(open) => {
          if (!busy) setSourcesOpen(open);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Plugin sources</DialogTitle>
            <DialogDescription>
              Plugin list URLs for this workspace on this device. Sync combines
              their plugins and publisher keys.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {sources.map((url, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="url"
                  aria-label={`Plugin source ${index + 1}`}
                  value={url}
                  disabled={Boolean(busy)}
                  placeholder="https://example.com/plugins.json"
                  onChange={(event) =>
                    setSources(
                      sources.map((value, i) =>
                        i === index ? event.target.value : value,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove source ${index + 1}`}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    setSources(sources.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="outline"
              disabled={Boolean(busy) || sources.length >= 20}
              onClick={() => setSources([...sources, ""])}
            >
              <Plus />
              Add source
            </Button>
            <Button
              disabled={Boolean(busy) || sources.some((url) => !url.trim())}
              onClick={() =>
                void work("sources", async () => {
                  await runtime.saveInventorySources(
                    sources.map((url) => url.trim()),
                  );
                  setSourcesOpen(false);
                  notify.success("Plugin sources saved and synced.");
                })
              }
            >
              {busy === "sources" ? "Syncing…" : "Save and sync"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>
              Package details and permissions
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <p>{selected.description}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt>Version</dt>
                <dd>{selected.version}</dd>
                <dt>Publisher</dt>
                <dd>{selected.publisher}</dd>
                <dt>License</dt>
                <dd>{selected.license}</dd>
                <dt>Dependencies</dt>
                <dd>{selected.dependencies.join(", ") || "Core only"}</dd>
                <dt>Permissions</dt>
                <dd className="break-words">
                  {(
                    selectedEntry?.grants ??
                    runtime.installedPackage(selected.id)?.grants ??
                    selected.permissions
                  ).join(", ") || "None"}
                </dd>
              </dl>
              <PackageLinks
                entry={selectedEntry}
                required={isRequiredCore(selected.id)}
              />
              {updateAvailable && (
                <Button
                  variant="outline"
                  disabled={Boolean(busy) || !writable}
                  onClick={() => void action(selected.id, "install")}
                >
                  <Download />
                  Update to {selectedDownload.version}
                </Button>
              )}
              {states.find((state) => state.id === selected.id)?.installed &&
                Object.keys(selected.features).length > 0 && (
                  <div className="space-y-2 border-t pt-3">
                    <h3 className="text-sm font-medium">Features</h3>
                    {Object.keys(selected.features).map((feature) => {
                      const state = states.find(
                        (state) => state.id === selected.id,
                      )!;
                      return (
                        <label
                          key={feature}
                          className="flex items-center gap-2 text-sm"
                        >
                          <FieldInput
                            definition={field(
                              feature.replace(/([A-Z])/g, "_$1").toLowerCase(),
                              feature.replace(/([A-Z])/g, " $1"),
                              "boolean",
                              { nullable: false },
                            )}
                            value={state.features.includes(feature)}
                            disabled={Boolean(busy) || !writable}
                            onChange={(value) =>
                              void work(selected.id, async () => {
                                await runtime.configurePlugin(
                                  selected.id,
                                  value
                                    ? [...state.features, feature]
                                    : state.features.filter(
                                        (id) => id !== feature,
                                      ),
                                );
                                notify.success("Plugin features updated.");
                              })
                            }
                          />
                          {feature.replace(/([A-Z])/g, " $1")}
                        </label>
                      );
                    })}
                  </div>
                )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PackageLinks({
  entry,
  required,
}: {
  entry?: InventoryEntry;
  required: boolean;
}) {
  if (required)
    return (
      <p className="text-sm text-muted-foreground">
        Included with Jocki. Required core plugins stay installed and
        enabled.
      </p>
    );
  if (!entry)
    return (
      <p className="text-sm text-muted-foreground">
        Verified package stored on this device.
      </p>
    );
  return (
    <div className="space-y-2 break-all text-sm">
      <a
        className="block underline"
        href={entry.downloadUrl}
        target="_blank"
        rel="noreferrer"
      >
        Download package
      </a>
      {entry.documentationUrl && (
        <a
          className="block underline"
          href={entry.documentationUrl}
          target="_blank"
          rel="noreferrer"
        >
          Documentation
        </a>
      )}
      <p className="text-xs text-muted-foreground">SHA-256: {entry.sha256}</p>
    </div>
  );
}
