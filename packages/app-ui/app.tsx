import { PluginsView } from "./plugins-view";
import { LoadingSpinner } from "../ui/loading-spinner";
import {
  beginWorkspaceOpen,
  finishWorkspaceOpen,
  interruptedWorkspaceOpen,
  workspaceOpenProgress,
  workspaceOpenStage,
  workspaceOpenFailure,
  workspaceOpeningKey,
} from "./workspace-startup";
import { consumeNativeRuntimeEvents } from "../platform-native/diagnostics";
import { reportSyncError } from "../sync/errors";
import { Diagnostics, ApplicationBoundary } from "./diagnostics";
import { SharedWorkspaceSettings } from "./workspace-settings";
import { WorkspaceTimers } from "./workspace-timers";
import { notify, useNotificationState } from "../ui/notifications";
import { Toaster } from "../ui/primitives/sonner";
import { recordValues } from "@jocki/platform/core/field-references";
import { StorageOverview } from "./storage-overview";
import {
  useEffect,
  useState,
  useMemo,
  useSyncExternalStore,
  Component,
  type ReactNode,
  Suspense,
} from "react";
import { useLiveQuery } from "../data-duckdb/react";
import { ThemeProvider, useTheme } from "next-themes";
import { Trash2 } from "lucide-react";
import {
  AppRuntime,
  profiles,
  deleteSavedWorkspace,
  type WorkspaceProfile,
} from "./runtime";
import { DeleteWorkspaceDialog } from "./delete-workspace-dialog";
import { RecordTable } from "./record-table";
import { getSchema } from "@jocki/platform/core/catalog";
import { WorkspaceNavigation } from "./workspace-navigation";
import { pluginNavigation, pageRoute, resolveNavigation } from "./navigation";
import { CollectionTableSettings } from "./collection-table-settings";
import { tableSelectionKey } from "./collection-tables";
import { ChoiceSelect } from "../ui/choice-select";
import { ReferenceOptionsContext } from "../ui/fields";
import { SyncConflicts } from "./sync-conflicts";
import { Welcome, activeWorkspaceKey } from "./welcome";
import { WorkspaceFileSettings } from "./workspace-files";
import { DatabaseSettings } from "./database-settings";
import { isRequiredCore } from "@jocki/platform/core/catalog";
import { Button } from "../ui/primitives/button";
import {
  FilesView,
  CredentialsView,
  TablesView,
  DevicesView,
} from "./storage-views";
export default function Application() {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ApplicationBoundary>
        <WorkspaceApp onWorkspaceState={setWorkspaceOpen} />
      </ApplicationBoundary>
      <Diagnostics floating={workspaceOpen} />
      <Toaster
        position="bottom-right"
        mobileOffset={{
          bottom: "calc(4rem + env(safe-area-inset-bottom))",
          left: 16,
          right: 16,
        }}
        closeButton
        richColors
        visibleToasts={3}
        toastOptions={{ style: { overflowWrap: "anywhere" } }}
      />
    </ThemeProvider>
  );
}
function WorkspaceApp({
  onWorkspaceState,
}: {
  onWorkspaceState: (open: boolean) => void;
}) {
  const [runtime, setRuntime] = useState<AppRuntime | null>(null),
    [loading, setLoading] = useState<string | null>(
      "Loading recent workspaces…",
    ),
    [error, setError] = useNotificationState("error", "");
  useEffect(() => {
    onWorkspaceState(Boolean(runtime));
  }, [runtime, onWorkspaceState]);
  useEffect(() => {
    let disposed = false;
    let current: AppRuntime | undefined;
    void (async () => {
      try {
        const interruptedStage = workspaceOpenStage(localStorage);
        const interruptedId =
          localStorage.getItem(workspaceOpeningKey) ?? undefined;
        const nativeEvents = await consumeNativeRuntimeEvents();
        const interruptedError = workspaceOpenFailure(
          localStorage,
          nativeEvents,
        );
        if (interruptedWorkspaceOpen(localStorage)) {
          localStorage.removeItem(activeWorkspaceKey);
          setError(
            reportSyncError(interruptedError, {
              phase: "workspace-open-interrupted",
              operation: interruptedStage ?? "startup",
              workspaceId: interruptedId,
            }).message,
          );
          return;
        }
        if (
          nativeEvents.some((event) => event.type === "web-content-terminated")
        ) {
          const workspaceId =
            localStorage.getItem(activeWorkspaceKey) ?? undefined;
          localStorage.removeItem(activeWorkspaceKey);
          setError(
            reportSyncError(
              Object.assign(
                new Error(
                  "iOS terminated the app’s web process. Workspace reopening is paused. Choose Open when you are ready to inspect the workspace.",
                ),
                { kind: "WEB_CONTENT_TERMINATED" },
              ),
              {
                phase: "native-runtime-termination",
                workspaceId,
              },
            ).message,
          );
          return;
        }
        const saved = await profiles();
        if (disposed) return;
        const selected = saved.find(
          (profile) => profile.id === localStorage.getItem(activeWorkspaceKey),
        );
        if (selected) {
          current = new AppRuntime(selected);
          beginWorkspaceOpen(localStorage, selected.id);
          await current.initialize((message) => {
            workspaceOpenProgress(localStorage, selected.id, message);
            if (!disposed) setLoading(message);
          });
          if (disposed) await current.close();
          else setRuntime(current);
        }
      } catch (e) {
        await current?.close().catch((error) =>
          reportSyncError(error, {
            phase: "failed-open-cleanup",
            workspaceId: current?.profile.workspaceId,
          }),
        );
        setError(
          reportSyncError(e, {
            phase: "workspace-open",
            workspaceId: current?.profile.workspaceId,
          }).message,
        );
      } finally {
        if (current) finishWorkspaceOpen(localStorage, current.profile.id);
        if (!disposed) setLoading(null);
      }
    })();
    return () => {
      disposed = true;
      void current?.close().catch((error) =>
        reportSyncError(error, {
          phase: "workspace-close",
          workspaceId: current?.profile.workspaceId,
        }),
      );
    };
  }, []);
  async function open(profile: WorkspaceProfile) {
    setLoading(
      runtime ? "Closing current workspace…" : `Preparing ${profile.name}…`,
    );
    const next = new AppRuntime(profile);
    beginWorkspaceOpen(localStorage, profile.id);
    try {
      await runtime?.close();
      setRuntime(null);
      await next.initialize((message) => {
        workspaceOpenProgress(localStorage, profile.id, message);
        setLoading(message);
      });
      localStorage.setItem(activeWorkspaceKey, profile.id);
      location.hash = "";
      setRuntime(next);
      setError("");
    } catch (e) {
      await next.close().catch((error) =>
        reportSyncError(error, {
          phase: "failed-open-cleanup",
          workspaceId: profile.workspaceId,
        }),
      );
      setError(
        reportSyncError(e, {
          phase: "workspace-open",
          workspaceId: profile.workspaceId,
        }).message,
      );
      throw e;
    } finally {
      finishWorkspaceOpen(localStorage, profile.id);
      setLoading(null);
    }
  }
  if (loading) return <LoadingSpinner label={loading} className="min-h-dvh" />;
  if (!runtime)
    return (
      <>
        <Welcome onOpen={open} error={error} />
      </>
    );
  return (
    <Shell
      key={runtime.profile.id}
      runtime={runtime}
      onSwitch={() => {
        localStorage.removeItem(activeWorkspaceKey);
        location.hash = "";
        setLoading("Closing workspace…");
        void runtime
          .close()
          .catch((error) => setError(String(error)))
          .finally(() => {
            setRuntime(null);
            setLoading(null);
          });
      }}
    />
  );
}
function Shell({
  runtime,
  onSwitch,
}: {
  runtime: AppRuntime;
  onSwitch: () => void;
}) {
  const referenceRecords =
    useLiveQuery(
      () => runtime.db.records.filter((r) => !r.deletedAt).toArray(),
      [runtime],
    ) ?? [];
  const version = useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
    () => 0,
  );
  const states = useLiveQuery(() => runtime.db.plugins.toArray(), [runtime]);
  const entries = useMemo(
    () => pluginNavigation(runtime),
    [runtime, version, states],
  );
  const pending = useLiveQuery(() => runtime.db.outbox.count(), [runtime]) ?? 0;
  const [view, setView] = useState(() => location.hash.slice(1) || "plugins"),
    [syncing, setSyncing] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const referenceOptions = useMemo(() => {
    const result: Record<
      string,
      Array<{ id: string; label: string; uid?: string; tableId?: string }>
    > = {
      resources: [],
    };
    for (const record of referenceRecords) {
      const values = recordValues(record);
      const option = {
        id: record.id,
        uid: typeof values.uid === "string" ? values.uid : record.id,
        tableId:
          typeof record.data.table_id === "string"
            ? record.data.table_id
            : undefined,
        label: String(
          values.title ??
            values.name ??
            values.subject ??
            values.summary ??
            values.uid ??
            record.id,
        ),
      };
      (result[record.collection] ??= []).push(option);
      if (record.collection !== "credentials") result.resources.push(option);
    }
    return result;
  }, [referenceRecords]);
  function navigate(route: string) {
    location.hash = route;
    setView(route);
  }
  useEffect(() => {
    const hash = () => setView(location.hash.slice(1) || "plugins"),
      network = () => {
        setOnline(navigator.onLine);
        if (navigator.onLine) notify.info("Connection restored.");
        else
          notify.warning(
            "You are offline. Changes will sync when a peer is reachable.",
          );
      };
    window.addEventListener("hashchange", hash);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, []);
  useEffect(() => {
    runtime.navigate = async (pluginId, pageId, recordId) => {
      try {
        const record = recordId
          ? await runtime.db.records.get(recordId)
          : undefined;
        const plugin =
          entries.find((p) => p.id === pluginId) ??
          (record && entries.find((p) => p.id === record.pluginId));
        if (!plugin) throw Error("Enable this plugin to open its content");
        const page = pageId
          ? (plugin.pages.find((p) => p.id === pageId) ?? plugin.main)
          : record
            ? ([plugin.main, ...plugin.pages].find(
                (p) => p.collection === record.collection && !p.columns,
              ) ?? plugin.main)
            : plugin.main;
        if (
          record &&
          getSchema(record.collection).tables &&
          record.data.table_id
        ) {
          const table = await runtime
            .collection("tables", true)
            .get(String(record.data.table_id));
          if (!table?.data.schema_id)
            throw Error("The entry's schema is unavailable");
          await runtime.db.setMetadata(
            tableSelectionKey(record.collection),
            String(table.data.schema_id),
          );
        } else if (record && getSchema(record.collection).tables)
          await runtime.db.metadata.delete(
            tableSelectionKey(record.collection),
          );
        navigate(
          pageRoute(plugin, page) +
            (recordId ? "?record=" + encodeURIComponent(recordId) : ""),
        );
      } catch (e) {
        notify.error(e);
      }
    };
    return () => {
      runtime.navigate = () => {};
    };
  }, [runtime, entries]);
  const synchronize = async () => {
    setSyncing(true);
    try {
      await runtime.synchronize();
      notify.success("Workspace synchronized.");
    } catch (e) {
      notify.error(e);
    } finally {
      setSyncing(false);
    }
  };
  useEffect(() => {
    if (!runtime.profile.connected) return;
    const sync = () => void runtime.synchronize().catch(notify.error);
    sync();
    const timer = setInterval(sync, 15000);
    return () => clearInterval(timer);
  }, [runtime, online]);
  const { plugin, page } = resolveNavigation(entries, view);
  let content: ReactNode;
  const id = plugin?.id;
  if (!plugin || !page || plugin.enabled === false)
    content = (
      <div className="empty-state">
        <h3>This page is not available</h3>
        <p>Enable the plugin to open its pages.</p>
        <Button onClick={() => navigate("plugins")}>Open Plugins</Button>
      </div>
    );
  else if (id === "plugins") content = <PluginsView runtime={runtime} />;
  else if (id === "settings" && page.id === "storage")
    content = <StorageOverview runtime={runtime} />;
  else if (id === "settings")
    content = <SettingsView runtime={runtime} onSwitch={onSwitch} />;
  else if (id === "files") content = <FilesView runtime={runtime} />;
  else if (id === "credentials")
    content = <CredentialsView runtime={runtime} />;
  else if (id === "tables") content = <TablesView runtime={runtime} />;
  else if (id === "devices") content = <DevicesView runtime={runtime} />;
  else if (id === "jobs")
    content = (
      <RecordTable
        runtime={runtime}
        collection="jobs"
        readOnly
        renderActions={(row) =>
          ["queued", "running", "waiting"].includes(String(row.data.status)) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await runtime.api("jobs/cancel", { id: row.id });
                await runtime.synchronize();
              }}
            >
              Cancel
            </Button>
          ) : null
        }
      />
    );
  else if (page.columns && page.collection)
    content = (
      <CollectionTableSettings
        key={page.collection}
        runtime={runtime}
        collection={page.collection}
      />
    );
  else if (page.surface && runtime.surfaces.has(page.surface)) {
    const Surface = runtime.surfaces.get(page.surface)!.render;
    content = (
      <PluginBoundary key={page.surface}>
        <Surface />
      </PluginBoundary>
    );
  } else if (page.collection)
    content = (
      <RecordTable
        key={page.collection}
        runtime={runtime}
        collection={page.collection}
        readOnly={page.readOnly}
        managedAccess={id}
      />
    );
  else if (id && isRequiredCore(id))
    content = <RecordTable runtime={runtime} collection={id} />;
  else
    content = (
      <p className="text-sm text-muted-foreground">
        This plugin provides commands and background services.
      </p>
    );
  return (
    <WorkspaceNavigation
      runtime={runtime}
      entries={entries}
      view={view}
      navigate={navigate}
      pending={pending}
      online={online}
      syncing={syncing}
      synchronize={synchronize}
      onSwitch={onSwitch}
    >
      <WorkspaceTimers runtime={runtime} />
      <Suspense
        key={id + ":" + page?.id}
        fallback={
          <LoadingSpinner label={`Opening ${plugin?.label ?? "plugin"}…`} />
        }
      >
        {!runtime.node.records.metadataReady() ? (
          <LoadingSpinner label="Waiting for workspace data…" />
        ) : ["draining", "replacing"].includes(runtime.node.lifecycle.phase) ? (
          <LoadingSpinner label="Updating workspace history…" />
        ) : (
          <ReferenceOptionsContext.Provider value={referenceOptions}>
            {content}
          </ReferenceOptionsContext.Provider>
        )}
      </Suspense>
    </WorkspaceNavigation>
  );
}
class PluginBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    reportSyncError(error, { phase: "plugin-render" });
  }
  render() {
    return this.state.failed ? (
      <Button
        variant="outline"
        onClick={() => this.setState({ failed: false })}
      >
        Retry plugin view
      </Button>
    ) : (
      this.props.children
    );
  }
}
function SettingsView({
  runtime,
  onSwitch,
}: {
  runtime: AppRuntime;
  onSwitch: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const { theme, setTheme } = useTheme();
  const homePreference = useLiveQuery(
    () => runtime.db.getMetadata<string>("navigation.home"),
    [runtime],
  );
  const homes = [...runtime.homeDestinations.entries()].filter(([, home]) =>
    runtime.registry.enabled(home.pluginId),
  );
  return (
    <div className="space-y-6">
      <section className="settings-card">
        <h2>Appearance</h2>
        <label className="field-row mt-3">
          Theme
          <ChoiceSelect
            aria-label="Color theme"
            value={theme ?? "system"}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onValueChange={setTheme}
          />
        </label>
      </section>
      <section className="settings-card">
        <h2>Workspace</h2>
        <p className="text-sm text-muted-foreground">{runtime.workspaceName}</p>
        <label className="field-row mt-3">
          Workspace home
          <ChoiceSelect
            aria-label="Workspace home"
            value={
              homePreference && runtime.homeDestinations.has(homePreference)
                ? homePreference
                : "plugins"
            }
            options={[
              { value: "plugins", label: "Plugins" },
              ...homes.map(([value, home]) => ({ value, label: home.title })),
            ]}
            disabled={!runtime.node.records.canWrite()}
            onValueChange={(value) =>
              void runtime.setHome(value).catch(notify.error)
            }
          />
        </label>

        <Button
          variant="outline"
          className="my-3"
          onClick={() => {
            location.hash = "settings:storage";
          }}
        >
          Manage storage copies
        </Button>
      </section>
      <SharedWorkspaceSettings runtime={runtime} />
      <section className="settings-card space-y-3">
        <h2>Workspace files</h2>
        <WorkspaceFileSettings runtime={runtime} />
      </section>
      <SyncConflicts runtime={runtime} />
      <DatabaseSettings />
      <section className="settings-card space-y-4 border-destructive/30">
        <h2 className="text-destructive">Danger zone</h2>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div>
            <h3>Remove workspace</h3>
            <p className="text-sm text-muted-foreground">
              Remove this workspace from the saved list on this device.
            </p>
          </div>
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            <Trash2 />
            Remove workspace
          </Button>
        </div>
      </section>
      {deleting && (
        <DeleteWorkspaceDialog
          profile={runtime.profile}
          onClose={() => setDeleting(false)}
          onDelete={async () => {
            await runtime.close();
            await deleteSavedWorkspace(runtime.profile);
            onSwitch();
          }}
        />
      )}
    </div>
  );
}
