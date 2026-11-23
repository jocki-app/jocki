import {
  applyCSDBFormBuffer,
  type CSDBFormSession,
} from "./vault-csdb-form-model";
import {
  CSDBAttributeForm,
  type CSDBFormState,
  type FormRow,
} from "./vault-csdb-form";
import { CSDBSettings } from "./vault-csdb-settings";
import { FilePicker, type PickerRoot } from "./file-picker";
import {
  readCSDBImportSettings,
  mergeCSDBImport,
  instantiateCSDBTemplate,
  type CSDBImportProfile,
} from "../core/vaults/csdb-import";
import { WorkspaceIcon } from "./workspace-icon";
import { featureDialogClass, type FeatureTarget } from "./vault-feature-model";
import { FeatureInfo } from "./vault-feature-controls";
import { newResource } from "../core/vaults/metadata";
import { VaultMetadataEditor } from "./vault-metadata-editor";
import { VaultFeatureButtons } from "./vault-feature-buttons";
import { VaultScopeHistory } from "./vault-scope-history";
import { SaveStatusButton } from "../ui/save-status-button";
import { logError, logger } from "../core/local-logs";
import {
  ContributionMenu,
  ContributionContextMenu,
  ToolbarContribution,
  ContributionItems,
  ContributionIcon,
  type MenuBindings,
} from "./contribution-menu";
import { registerCoreMenus } from "./core-menus";
import {
  SettingsPage,
  PluginSettingsPage,
  LogsPage,
} from "./vault-settings-pages";
import {
  FileViewPicker,
  VaultStatusBar,
  VaultNavigation,
  type FileViewContribution,
} from "./vault-contribution-regions";
import { validDock } from "../ui/dock-model";
import type {
  MenuContext,
  RegisteredMenu,
} from "../platform/src/file-sdk/ui-registry";
import { useReportedError } from "./errors";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from "@xyflow/react";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { FileVault, Draft } from "../core/vaults/vault";
import { fileBytes, fileText } from "../core/vaults/vault";
import type { FileHandler, FileSummary } from "../core/vaults/contracts";
import { handlersFor, validateType } from "../core/vaults/handlers";
import { contentTypes } from "../core/vaults/content-types";
import { validateCSDBType } from "../core/vaults/csdb";
import { mimeType } from "../core/vaults/mime";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/primitives/collapsible";
import { parseCanvas } from "../core/vaults/canvas";
import { VaultSearch } from "../core/vaults/search";
import { VaultRequests } from "./vault-requests";
import { VaultSearchPane } from "./vault-search-pane";
import {
  graph,
  noteMetadata,
  resolveLink,
  rewriteMovedLinks,
  withProperties,
  type LinkableFile,
} from "../core/vaults/knowledge";
import { applyTemplate, checkTemplateOnOpen } from "../core/vaults/templates";
import {
  patchSettings,
  emptyOverrides,
  type WorkspaceDefaults,
  type ComputerOverrides,
} from "../core/vaults/workspace";
import { canonical, utf8 } from "../core/crypto";
import {
  VaultMarkdownEditor,
  type MarkdownContext,
  type MarkdownAsset,
} from "./vault-markdown-editor";
import { CSDBEditor, newCSDB } from "./vault-csdb-editor";
import { CanvasEditor } from "./vault-canvas-editor";
import { VaultSharing, SharingSettings } from "./vault-sharing";
import { ExtensionWebview } from "./vault-extension-webview";
import { FilePluginSettings } from "./vault-plugin-settings";
import {
  ExtensionViews,
  ExtensionConfiguration,
} from "./vault-extension-contributions";
import { ExtensionDocumentView, VaultSQLView } from "./vault-extra-views";
import { VaultPolicyTable } from "./vault-policy-table";
import { VaultCollectionEditor } from "./vault-collection-editor";
import {
  IconButton,
  CheckboxInput,
  VaultTopbar,
  VaultExplorer,
  ExplorerMenu,
  explorerContext,
  SettingsDrawer,
  MobileTools,
  VaultDock,
  startPaneDrag,
  startPanePointer,
  type VaultTemplate,
} from "./vault-shell";
import {
  vaultTemplates,
  VaultTemplateSettings,
  updatePluginPreferences,
  type PluginFilePreferences,
} from "./vault-template-settings";
import { type DockTab, type DockLayout, type DockView } from "../ui/dock-model";
import type { CollectionViewState } from "../ui/collection-view-model";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { LegacySelect } from "../ui/choice-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/primitives/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../ui/primitives/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/primitives/dropdown-menu";
import {
  Save,
  Undo2,
  Copy,
  Pencil,
  BookTemplate,
  History,
  Share2,
  FilePenLine,
  ListTree,
  Link2,
  Tags,
  ListFilter,
  Columns3,
  Code2,
  ExternalLink,
  Star,
  Pin,
  ChevronDown,
} from "lucide-react";
import "./vault-app.css";

const CodeEditor = lazy(() => import("./vault-code-editor"));
const FileHistory = lazy(() => import("./vault-history"));
interface Tab {
  vault: string;
  id: string;
  draft: Draft;
  handler: string;
  pinned: boolean;
  reveal?: string;
  form?: CSDBFormState;
  formSession?: CSDBFormSession;
  imported?: { token: string; rows: FormRow[] };
  popout?: Window;
  editorId?: string;
  session?: string;
  view?: DockView;
  webview?: string;
}
const tabDirty = (tab: Tab) =>
  tab.draft.dirty || !!tab.form?.pending || !!tab.formSession?.buffer?.pending;
interface Modal {
  title: string;
  feature?: "history" | "sync";
  body: ReactNode;
  actions?: ReactNode;
  cancel?(): void;
  wide?: boolean;
}
const fileKey = (tab: Pick<Tab, "vault" | "id">) => `${tab.vault}/${tab.id}`;
const tabKey = (tab: Pick<Tab, "vault" | "id"> & { session?: string }) =>
  fileKey(tab) + (tab.session ? "@" + tab.session : "");

/** All editors, including plugins, are hosted against the same explicit-save draft. */
export default function VaultApplication({
  runtime,
  onHome,
  startPage,
}: {
  runtime: VaultRuntime;
  onHome?(): void;
  startPage?: string;
}) {
  const [navigation, setNavigation] = useState("core.navigation.files");
  const [revision, refresh] = useState(0),
    [tabs, setTabs] = useState<Tab[]>([]),
    [active, setActive] = useState(
      () =>
        runtime.workspace.settings(runtime.computer).layout.active ??
        "app:workspace",
    );
  const [appTabs, setAppTabs] = useState<string[]>(() => {
    const saved = runtime.workspace.settings(runtime.computer).layout;
    return validDock(saved.dock)
      ? [
          ...new Set(
            saved.dock.panes
              .flatMap((p) => p.tabs)
              .filter((t) => t.view === "page" && t.file.startsWith("app:"))
              .map((t) => t.file),
          ),
        ]
      : saved.tabs.length
        ? []
        : ["app:workspace"];
  });
  const [knownVaults, setKnownVaults] = useState<
    Array<{ id: string; location: string; workspace: string }>
  >([]);
  const [layoutReady, setLayoutReady] = useState(false);
  function openAppPage(id: string) {
    const key = "app:" + id;
    setAppTabs((prior) => (prior.includes(key) ? prior : [...prior, key]));
    setActive(key);
    setSettingsOpen(false);
    paneAPI.current?.open({ file: key, view: "page" });
  }
  const [filesOpen, setFilesOpen] = useState(true),
    [settingsOpen, setSettingsOpen] = useState(false),
    [mobileFiles, setMobileFiles] = useState(false);
  const [inlineRename, setInlineRename] = useState<{
    vault: string;
    path: string;
    folder: boolean;
    fresh?: boolean;
  }>();
  const [dockLayout, setDockLayout] = useState<unknown>(
    () => runtime.workspace.settings(runtime.computer).layout.dock,
  );
  const [desktopControls, setDesktopControls] = useState<HTMLDivElement | null>(
      null,
    ),
    [mobileControls, setMobileControls] = useState<HTMLDivElement | null>(null);
  const paneAPI = useRef<{
    open(tab: DockTab): void;
    split(tab: DockTab): void;
    replace(from: DockTab, to: DockTab): void;
  }>(undefined);
  const [query, setQuery] = useState(""),
    [typeFilter, setTypeFilter] = useState("");
  const [modal, setModal] = useState<Modal>(),
    [error, setError] = useReportedError("vault-app"),
    [busy, setBusy] = useState(false);
  const [split, setSplit] = useState(false),
    [stacked, setStacked] = useState(false),
    [secondary, setSecondary] = useState("");
  const [graphLinks, setGraphLinks] = useState(true),
    [graphMetadata, setGraphMetadata] = useState(false),
    [graphHierarchy, setGraphHierarchy] = useState(false);
  const [graphLocal, setGraphLocal] = useState(false),
    [depth, setDepth] = useState(1),
    [graphFilter, setGraphFilter] = useState("");
  const [rightPanel, setRightPanel] = useState<
    "links" | "outline" | "properties" | "tags"
  >("links");
  const [settingsTarget, setSettingsTarget] = useState("defaults"),
    [settingsJSON, setSettingsJSON] = useState("");
  const [indexRevision, setIndexRevision] = useState(0);
  const indexed = () => {
    setIndexRevision((n) => n + 1);
    pulse();
  };
  const search = useRef(
      new VaultSearch(
        (doc) => runtime.extensions.extractText(doc),
        (error) => setError(error),
      ),
    ),
    latest = useRef({ tabs, active });
  latest.current = { tabs, active };
  const pulse = () => refresh((n) => n + 1);
  const execute = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      pulse();
    }
  };
  const settings = runtime.workspace.settings(runtime.computer);
  const vaultSignature = [...runtime.vaults.values()]
    .map((vault) => vault.id + ":" + vault.version)
    .join();
  const vaults = useMemo(() => [...runtime.vaults.values()], [vaultSignature]);
  const files = useMemo(
    () => vaults.flatMap((v) => v.list().map((f) => ({ ...f, vault: v.id }))),
    [vaultSignature],
  );
  const linkables: LinkableFile[] = useMemo(() => {
    const indexed = new Map(
      search.current
        .all()
        .map((entry) => [entry.vault + "/" + entry.id, entry]),
    );
    return files.map((f) => {
      const vault = runtime.vaults.get(f.vault)!,
        metadata = vault.metadata(f.id);
      return {
        id: f.id,
        path: f.path,
        vault: f.vault,
        text:
          f.mime === "text/markdown"
            ? vault.isLoaded(f.id)
              ? fileText(vault.doc(f.id))
              : (indexed.get(f.vault + "/" + f.id)?.text ?? "")
            : "",
        metadata: metadata.properties,
        metadataTerms: metadata.terms,
        resourceLinks: metadata.links,
      };
    });
  }, [vaultSignature, indexRevision]);
  const current = tabs.find((t) => tabKey(t) === active);
  const lastDocument = useRef<string | undefined>(undefined);
  if (current) lastDocument.current = fileKey(current);
  const meta = useMemo(
    () =>
      current?.draft.mime === "text/markdown"
        ? noteMetadata(current.draft.text)
        : undefined,
    [current?.draft.text, current?.draft.mime],
  );
  const urlCache = useRef(new Map<string, { revision: string; url: string }>());
  const dirty = tabs.some((t) => tabDirty(t));
  useEffect(
    () => () => {
      for (const asset of urlCache.current.values())
        URL.revokeObjectURL(asset.url);
      urlCache.current.clear();
    },
    [],
  );
  const restoring = useRef<Promise<void>>(Promise.resolve());
  const pendingClose = useRef<((allow: boolean) => void) | undefined>(
    undefined,
  );
  useEffect(() => {
    const confirmClose = async () => {
      await restoring.current;
      if (!runtime.editors.documents().some((document) => document.dirty))
        return runtime
          .flush()
          .then(() => true)
          .catch((error) => {
            setError(error);
            return false;
          });
      return new Promise<boolean>((resolve) => {
        pendingClose.current?.(false);
        pendingClose.current = resolve;
        const finish = async (allow: boolean) => {
          if (allow) await runtime.flush();
          pendingClose.current?.(allow);
          pendingClose.current = undefined;
          setModal(undefined);
        };
        setModal({
          title: "Save changes before closing the workspace?",
          body: (
            <p>
              {
                runtime.editors.documents().filter((document) => document.dirty)
                  .length
              }{" "}
              files have unsaved changes.
            </p>
          ),
          actions: (
            <>
              <Button variant="outline" onClick={() => void finish(false)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void execute(async () => {
                    for (const tab of latest.current.tabs)
                      if (
                        runtime.editors.snapshot(tab.vault, tab.id, tab.session)
                          .dirty
                      )
                        runtime.editors.discard(tab.vault, tab.id, tab.session);
                    await finish(true);
                  })
                }
              >
                Discard
              </Button>
              <Button
                variant="outline"
                className="primary"
                onClick={() =>
                  void execute(async () => {
                    for (const tab of latest.current.tabs)
                      if (
                        runtime.editors.snapshot(tab.vault, tab.id, tab.session)
                          .dirty
                      )
                        await save(tab);
                    if (
                      !latest.current.tabs.some(
                        (t) =>
                          runtime.editors.snapshot(t.vault, t.id, t.session)
                            .dirty,
                      )
                    )
                      await finish(true);
                  })
                }
              >
                Save all
              </Button>
            </>
          ),
        });
      });
    };
    runtime.confirmClose = confirmClose;
    const remove = window.jockiVaults?.onWillClose?.(confirmClose);
    return () => {
      remove?.();
      runtime.confirmClose = undefined;
      pendingClose.current?.(false);
      pendingClose.current = undefined;
      for (const tab of latest.current.tabs) tab.popout?.close();
    };
  }, []);
  useEffect(() => {
    const subscription = runtime.extensions.onDidChangeContributions(pulse);
    const remove = runtime.editors.subscribe(pulse);
    const workspace = runtime.workspace.subscribe(pulse);
    return () => {
      subscription.dispose();
      remove();
      workspace();
    };
  }, []);
  useEffect(() => {
    void runtime.library.references().then(setKnownVaults).catch(setError);
  }, [runtime, vaults.map((v) => v.id).join(), runtime.workspace.current.name]);
  useEffect(() => {
    const viewLogs = () => openAppPage("logs");
    window.addEventListener("jocki:open-logs", viewLogs);
    return () => window.removeEventListener("jocki:open-logs", viewLogs);
  }, [runtime]);
  const extensionSignature = runtime.extensions
    .manifests()
    .map((m) => m.id + "@" + m.version)
    .join();
  const extractorSignature = extensionSignature;
  useEffect(() => {
    search.current.invalidateExtractors();
    for (const vault of runtime.vaults.values())
      void search.current
        .update(vault)
        .then(indexed)
        .catch((e) => setError(e));
  }, [extractorSignature]);
  useEffect(() => {
    if (current && runtime.editors.sessions.has(tabKey(current)))
      runtime.extensions.didChangeActiveEditor(
        runtime.editors.snapshot(current.vault, current.id, current.session),
      );
    else runtime.extensions.didChangeActiveEditor(undefined);
  }, [
    active,
    current?.vault,
    current?.id,
    current?.session,
    current?.editorId,
  ]);

  useEffect(() => {
    const remove = vaults.map((v) =>
      v.subscribe(() => {
        pulse();
        void search.current
          .update(v)
          .then(indexed)
          .catch((e) => setError(e));
      }),
    );
    for (const vault of vaults)
      void search.current
        .update(vault)
        .then(indexed)
        .catch((e) => setError(e));
    return () => remove.forEach((fn) => fn());
  }, [vaults.map((v) => v.id).join()]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (latest.current.tabs.some((t) => tabDirty(t))) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === "visible")
        for (const vault of runtime.vaults.values())
          void vault.reconcile().catch((error) => setError(error));
    };
    window.addEventListener("focus", visibility);
    document.addEventListener("visibilitychange", visibility);
    const remove = window.jockiVaults?.onFilesChanged?.(
      (token, changes) => {
        const mounts = runtime.workspace.settings(runtime.computer).vaults;
        const vault = [...runtime.vaults.values()].find(
          (vault) => mounts[vault.id] === token,
        );
        if (vault)
          void vault.reconcile(changes).catch((error) => setError(error));
      },
    );
    const timer = setInterval(visibility, 30000);
    return () => {
      window.removeEventListener("focus", visibility);
      document.removeEventListener("visibilitychange", visibility);
      remove?.();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    // A clean tab follows remote saves; a dirty tab keeps its baseline until Save.
    let changed = false;
    const next = latest.current.tabs
      .filter((tab) => {
        const mounted = runtime.vaults.has(tab.vault);
        if (!mounted) {
          changed = true;
          tab.popout?.close();
        }
        return mounted;
      })
      .map((t) => {
        const vault = runtime.vaults.get(t.vault);
        if (
          vault &&
          !tabDirty(t) &&
          !vault.entry(t.id).deleted &&
          (fileText(vault.doc(t.id)) !== t.draft.text ||
            vault.doc(t.id).mime !== t.draft.mime ||
            vault.contentType(t.id) !== t.draft.contentType)
        ) {
          changed = true;
          return {
            ...t,
            draft: runtime.editors.refresh(t.vault, t.id, t.session),
          };
        }
        return t;
      });
    if (changed) {
      setTabs(next);
      if (!next.some((tab) => tabKey(tab) === latest.current.active))
        setActive(next[0] ? tabKey(next[0]) : "");
    }
  }, [vaultSignature]);
  const rememberLayout = async (next: Tab[], selected: string) => {
    await runtime.workspace.update((d) => {
      const local = d.computers[runtime.computer];
      local.layout ??= {};
      patchSettings(local.layout as Record<string, unknown>, {
        ...local.layout,
        tabs: next.map(tabKey),
        active: selected || null,
        split,
        pinned: next.filter((t) => t.pinned).map(tabKey),
        stacked,
        secondary: secondary || null,
      });
    });
  };
  const flushForm = (tab: Tab) => {
    if (tab.form) tab.form.flush();
    else if (tab.formSession?.buffer?.pending) {
      const result = applyCSDBFormBuffer(
        tab.draft.text,
        tab.formSession.buffer,
      );
      tab.draft.text = result.text;
      tab.formSession.buffer.pending = false;
      tab.formSession.index = result.index;
      tab.formSession.buffer = undefined;
      runtime.editors.changed(tab.vault, tab.id, "edit", tab.session);
    }
  };
  const save = async (
    tab: Tab,
    description = "",
    rows?: import("../core/vaults/csdb").CSDBRowSelection,
  ) => {
    flushForm(tab);
    const next = await runtime.editors.save(
      tab.vault,
      tab.id,
      tab.session,
      description,
      rows,
    );
    setTabs((prior) =>
      prior.map((t) => (tabKey(t) === tabKey(tab) ? { ...t, draft: next } : t)),
    );
  };
  const discard = (tab: Tab) => {
    tab.form?.reset();
    if (tab.formSession) tab.formSession.buffer = undefined;
    const draft = runtime.editors.discard(tab.vault, tab.id, tab.session);
    setTabs((prior) =>
      prior.map((t) =>
        tabKey(t) === tabKey(tab) ? { ...t, draft, imported: undefined } : t,
      ),
    );
  };
  const changeWorkspace = (work: () => Promise<unknown>) => {
    if (!latest.current.tabs.some((tab) => tabDirty(tab))) {
      void execute(work);
      return;
    }
    const finish = (mode: "save" | "discard") =>
      void execute(async () => {
        for (const tab of latest.current.tabs) {
          if (!tabDirty(tab)) continue;
          if (mode === "save") await save(tab);
          else discard(tab);
        }
        runtime.assertWorkspaceCanChange();
        setModal(undefined);
        await work();
      });
    setModal({
      title: "Save changes before switching workspaces?",
      body: (
        <p>
          Open files have unsaved changes. Save or discard them before opening
          another workspace.
        </p>
      ),
      actions: (
        <>
          <Button variant="outline" onClick={() => setModal(undefined)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => finish("discard")}>
            Discard
          </Button>
          <Button onClick={() => finish("save")}>Save all</Button>
        </>
      ),
    });
  };
  const close = (tab: Tab) => {
    const finish = async () => {
      await runtime.editors.close(tab.vault, tab.id, true, tab.session);
      tab.popout?.close();
      const next = latest.current.tabs.filter((t) => tabKey(t) !== tabKey(tab));
      setTabs(next);
      setActive("");
      setModal(undefined);
      await rememberLayout(next, "");
    };
    if (!tabDirty(tab)) {
      void execute(finish);
      return;
    }
    setModal({
      title: "Save changes before closing?",
      body: (
        <p>
          {runtime.vaults.get(tab.vault)!.entry(tab.id).path} has unsaved
          changes.
        </p>
      ),
      actions: (
        <>
          <Button variant="outline" onClick={() => setModal(undefined)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => void execute(finish)}>
            Discard
          </Button>
          <Button
            variant="outline"
            className="primary"
            onClick={() =>
              void execute(async () => {
                await save(tab);
                await finish();
              })
            }
          >
            Save
          </Button>
        </>
      ),
    });
  };
  const fileViews = (
    vault: FileVault,
    file: Pick<FileSummary, "path" | "mime" | "contentType">,
  ): FileViewContribution[] =>
    runtime.extensions
      .editorContributions(file)
      .filter(
        (view) =>
          (view.id !== "core.file.history" ||
            vault.historyEnabled(
              vault.list().find((entry) => entry.path === file.path)!.id,
            )) &&
          (view.id !== "core.csdb.editor" ||
            file.contentType !== "jocki.task-list"),
      )
      .map((view) => ({
        ...view,
        plugin:
          runtime.extensions
            .manifests()
            .find((plugin) => plugin.id === view.extension)?.name ??
          view.extension,
      }));
  const openingTabs = useRef<Promise<unknown>>(Promise.resolve());
  const finishOpen = (
    vault: FileVault,
    file: FileSummary,
    handler: string,
    reveal?: string,
  ) => {
    const work = openingTabs.current.then(async () => {
      await restoring.current;

      const contribution = runtime.extensions
        .editorContributions(file)
        .find((view) => view.id === handler);
      const view: DockView = contribution
        ? `plugin:${contribution.id}`
        : "edit";
      const existing = latest.current.tabs.find(
        (tab) =>
          tab.vault === vault.id &&
          tab.id === file.id &&
          (contribution ? tab.editorId === contribution.id : tab.view === view),
      );
      if (existing) {
        paneAPI.current?.open({
          file: tabKey(existing),
          view: existing.view ?? "edit",
        });
        setActive(tabKey(existing));
        return existing;
      }
      if (contribution)
        await runtime.extensions.activate(contribution.extension);
      const instance = latest.current.tabs.some(
        (tab) => tab.vault === vault.id && tab.id === file.id,
      )
        ? crypto.randomUUID()
        : undefined;
      const session = await runtime.editors.open(vault.id, file.id, instance);
      const presentation = contribution
        ? await runtime.extensions.resolveEditor(
            handler,
            runtime.editors.snapshot(vault.id, file.id, instance),
          )
        : undefined;
      const tab: Tab = {
        vault: vault.id,
        id: file.id,
        session: instance,
        view,
        draft: session.draft,
        handler:
          presentation?.kind === "component"
            ? presentation.component
            : "generic",
        editorId: contribution?.id,
        webview:
          presentation?.kind === "webview" ? presentation.html : undefined,
        pinned: false,
        reveal,
      };
      const next = [...latest.current.tabs, tab],
        key = tabKey(tab);
      latest.current = { tabs: next, active: key };
      setTabs(next);
      setActive(key);
      setModal(undefined);
      paneAPI.current?.open({ file: key, view });
      await rememberLayout(next, key);
      return tab;
    });
    openingTabs.current = work.catch(() => {});
    return work;
  };
  const switchView = async (tab: Tab, selected: FileViewContribution) => {
    flushForm(tab);
    const existing = latest.current.tabs.find(
      (other) =>
        other.vault === tab.vault &&
        other.id === tab.id &&
        other.editorId === selected.id,
    );
    if (existing) {
      paneAPI.current?.open({
        file: tabKey(existing),
        view: existing.view ?? "edit",
      });
      setActive(tabKey(existing));
      return;
    }
    const presentation = await runtime.extensions.resolveEditor(
      selected.id,
      runtime.editors.snapshot(tab.vault, tab.id, tab.session),
    );
    const next = {
      ...tab,
      editorId: selected.id,
      view: `plugin:${selected.id}` as DockView,
      draft: runtime.editors.sessions.get(tabKey(tab))!.draft,
      handler:
        presentation.kind === "component" ? presentation.component : "generic",
      webview: presentation.kind === "webview" ? presentation.html : undefined,
    };
    paneAPI.current?.replace(
      { file: tabKey(tab), view: tab.view ?? "edit" },
      { file: tabKey(tab), view: next.view },
    );
    setTabs((prior) =>
      prior.map((item) => (tabKey(item) === tabKey(tab) ? next : item)),
    );
    setActive(tabKey(tab));
  };
  const openFile = async (
    vault: FileVault,
    file: FileSummary,
    reveal?: string,
    opened?: (success: boolean) => void,
  ) => {
    const existing = latest.current.tabs.find(
      (tab) => tab.vault === vault.id && tab.id === file.id,
    );
    if (existing) {
      paneAPI.current?.open({
        file: tabKey(existing),
        view: existing.view ?? "edit",
      });
      setActive(tabKey(existing));
      opened?.(true);
      return;
    }
    const candidates = runtime.extensions.editorContributions(file);
    await finishOpen(
      vault,
      file,
      candidates.find((view) => view.priority === "default")?.id ??
        candidates[0]?.id ??
        "generic",
      reveal,
    );
    opened?.(true);
  };
  const restoringLayout = useRef(true),
    restoredLayout = useRef(false);
  useEffect(() => {
    if (restoredLayout.current) return;
    restoredLayout.current = true;
    const layout = runtime.workspace.settings(runtime.computer).layout;
    restoring.current = (async () => {
      const restored: Tab[] = [];
      for (const key of layout.tabs) {
        const [vaultId, identity] = key.split("/"),
          [id, instance] = identity.split("@"),
          vault = runtime.vaults.get(vaultId),
          file = vault?.list().find((f) => f.id === id);
        if (!vault || !file) continue;
        try {
          const savedView = validDock(layout.dock)
            ? layout.dock.panes
                .flatMap((pane) => pane.tabs)
                .find((tab) => tab.file === key)?.view
            : undefined;
          const candidates = runtime.extensions.editorContributions(file),
            contribution = savedView?.startsWith("plugin:")
              ? candidates.find((view) => view.id === savedView.slice(7))
              : candidates.find((view) => view.priority === "default");
          const session = await runtime.editors.open(vaultId, id, instance),
            presentation = contribution
              ? await runtime.extensions.resolveEditor(
                  contribution.id,
                  runtime.editors.snapshot(vaultId, id, instance),
                )
              : undefined;
          restored.push({
            vault: vaultId,
            id,
            session: instance,
            view:
              savedView ??
              (contribution ? `plugin:${contribution.id}` : "edit"),
            draft: session.draft,
            handler:
              presentation?.kind === "component"
                ? presentation.component
                : "generic",
            editorId: contribution?.id,
            webview:
              presentation?.kind === "webview" ? presentation.html : undefined,
            pinned: layout.pinned?.includes(key) ?? false,
          });
        } catch (error) {
          setError(error);
        }
      }
      if (restored.length) {
        const selected =
          layout.active?.startsWith("app:") ||
          restored.some((t) => tabKey(t) === layout.active)
            ? layout.active!
            : tabKey(restored[0]);
        latest.current = { tabs: restored, active: selected };
        setTabs(restored);
        setActive(selected);
        setSplit(layout.split);
        setStacked(layout.stacked ?? false);
        setSecondary(layout.secondary ?? selected);
      }
      if (startPage) openAppPage(startPage);
      restoringLayout.current = false;
      setLayoutReady(true);
    })();
  }, []);
  const layoutSignature = JSON.stringify([
    tabs.map((t) => [tabKey(t), t.pinned]),
    active,
    split,
    stacked,
    secondary,
  ]);
  useEffect(() => {
    if (restoringLayout.current) return;
    void rememberLayout(tabs, active).catch((error) => setError(error));
  }, [layoutSignature]);
  const openLink = (tab: Tab, target: string) => {
    if (/^https?:\/\//i.test(target) || target.startsWith("mailto:")) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    const source = linkables.find((f) => fileKey(f) === fileKey(tab))!;
    const found = resolveLink(target, source, linkables);
    const fragment = target.split("#")[1];
    if (found.length === 1) {
      const f = found[0],
        v = runtime.vaults.get(f.vault)!;
      void execute(() =>
        openFile(
          v,
          v.list().find((e) => e.id === f.id)!,
          fragment,
        ),
      );
    } else if (found.length > 1)
      setModal({
        title: "Choose a linked file",
        body: (
          <div className="vault-list">
            {found.map((f) => (
              <Button
                variant="outline"
                key={tabKey(f)}
                onClick={() => {
                  setModal(undefined);
                  const v = runtime.vaults.get(f.vault)!;
                  void execute(() =>
                    openFile(
                      v,
                      v.list().find((e) => e.id === f.id)!,
                      fragment,
                    ),
                  );
                }}
              >
                {f.path}
              </Button>
            ))}
          </div>
        ),
      });
    else {
      const raw = target.split("#")[0].split("|")[0],
        path = raw.endsWith(".md") ? raw : raw + ".md";
      setModal({
        title: "Create linked note?",
        body: <p>{path}</p>,
        actions: (
          <>
            <Button variant="outline" onClick={() => setModal(undefined)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void execute(async () => {
                  const v = runtime.vaults.get(tab.vault)!;
                  const id = await v.create(
                    path,
                    utf8.encode("# " + raw.split("/").pop() + "\n"),
                  );
                  await openFile(
                    v,
                    v.list().find((f) => f.id === id)!,
                  );
                })
              }
            >
              Create
            </Button>
          </>
        ),
      });
    }
  };
  const asset = (tab: Tab, target: string): MarkdownAsset | undefined => {
    const source = linkables.find((f) => fileKey(f) === fileKey(tab));
    if (!source) return;
    const found = resolveLink(target, source, linkables);
    if (found.length !== 1) return;
    const f = found[0],
      vault = runtime.vaults.get(f.vault)!;
    if (!vault.isLoaded(f.id)) {
      void vault.load(f.id).then(pulse).catch(setError);
      return;
    }
    const doc = vault.doc(f.id);
    if (doc.kind === "text" && !doc.mime.startsWith("image/"))
      return { mime: doc.mime, text: fileText(doc) };
    const cacheKey = tabKey(f),
      cache = urlCache.current.get(cacheKey),
      revision = vault.documentRevision(f.id);
    if (cache?.revision === revision) return { mime: doc.mime, url: cache.url };
    if (cache) URL.revokeObjectURL(cache.url);
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(fileBytes(doc))], { type: doc.mime }),
    );
    urlCache.current.set(cacheKey, { revision, url });
    return { mime: doc.mime, url };
  };
  const markdownContext = (tab: Tab): MarkdownContext => ({
    suggestions: (q) =>
      linkables
        .filter(
          (f) =>
            f.vault === tab.vault &&
            (f.path.toLowerCase().includes(q.toLowerCase()) ||
              noteMetadata(f.text).aliases.some((a) =>
                a.toLowerCase().includes(q.toLowerCase()),
              )),
        )
        .map((f) => ({ target: f.path, label: f.path })),
    asset: (t) => asset(tab, t),
    open: (t) => openLink(tab, t),
    complete: (offset, token) =>
      runtime.extensions.completionsFor(
        runtime.editors.snapshot(tab.vault, tab.id, tab.session),
        offset,
        token,
      ),
  });
  const createAt = async (
    vault: FileVault,
    folder: string,
    type: string,
    initial?: {
      text: string;
      template?: { file: string; hint: string; text: string };
      mode?: "copy" | "reference";
      extension?: string;
    },
  ) => {
    setTypeFilter("");
    const descriptor = contentTypes.find((t) => t.id === type),
      extension =
        initial?.extension ??
        descriptor?.extensions[0] ??
        (
          {
            markdown: ".md",
            text: ".txt",
            csdb: ".csdb",
            canvas: ".canvas",
          } as Record<string, string>
        )[type] ??
        ".md";
    if (!descriptor && !["markdown", "text", "csdb", "canvas"].includes(type))
      throw Error("Unknown content type: " + type);
    const ext = extension.startsWith(".") ? extension : "." + extension;
    let index = 0,
      path: string;
    do {
      path = [folder, "Rename" + (index ? " " + index : "") + ext]
        .filter(Boolean)
        .join("/");
      index++;
    } while (vault.find(path));
    const source =
      (initial?.template && ext === ".csdb"
        ? instantiateCSDBTemplate(initial.text)
        : initial?.text) ??
      (ext === ".csdb"
        ? newCSDB(descriptor)
        : ext === ".canvas"
          ? '{"nodes":[],"edges":[]}\n'
          : "");
    validateType(
      { path, mime: mimeType(path), contentType: descriptor?.id ?? null },
      contentTypes,
    );
    if (ext === ".csdb") validateCSDBType(source, descriptor);
    if (ext === ".canvas") parseCanvas(source);
    const id = await vault.create(path, utf8.encode(source), {
      contentType: descriptor?.id ?? null,
    });
    await openFile(
      vault,
      vault.list().find((f) => f.id === id)!,
    );
    if (initial?.template && initial.mode === "reference") {
      const session = runtime.editors.sessions.get(vault.id + "/" + id)!;
      applyTemplate(session.draft, initial.template, "reference");
      session.draft.text = source;
      await save(
        latest.current.tabs.find((t) => t.id === id) ?? {
          vault: vault.id,
          id,
          draft: session.draft,
          handler: "markdown",
          pinned: false,
        },
      );
    }
    setInlineRename({ vault: vault.id, path, folder: false, fresh: true });
  };
  const newFile = (requested?: FileVault) => {
    const vault =
      requested ?? (current ? runtime.vaults.get(current.vault) : vaults[0]);
    if (!vault) return;
    const folder =
      current?.vault === vault.id
        ? vault.entry(current.id).path.split("/").slice(0, -1).join("/")
        : "";
    setModal({
      title: "New file",
      body: (
        <div className="grid gap-2">
          {[
            { id: "markdown", name: "Markdown" },
            { id: "text", name: "Text file" },
            { id: "csdb", name: "CSDB table" },
            { id: "canvas", name: "Canvas" },
            ...runtime.installedContentTypes(),
          ].map((type) => (
            <Button
              key={type.id}
              variant="outline"
              onClick={() =>
                void execute(() => createAt(vault, folder, type.id))
              }
            >
              {type.name}
            </Button>
          ))}
        </div>
      ),
    });
  };
  const rename = (tab: Tab) => {
    const vault = runtime.vaults.get(tab.vault)!,
      old = vault.entry(tab.id).path;
    let path = old;
    setModal({
      title: "Move or rename file",
      body: (
        <label>
          Vault-relative path
          <Input
            defaultValue={old}
            onChange={(e) => {
              path = e.target.value;
            }}
          />
        </label>
      ),
      actions: (
        <>
          <Button variant="outline" onClick={() => setModal(undefined)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void execute(async () => {
                await moveWithLinks(vault, old, path);
                setModal(undefined);
                pulse();
              })
            }
          >
            Move
          </Button>
        </>
      ),
    });
  };
  const saveCopy = (tab: Tab) => {
    let destination = tab.vault,
      path = runtime.vaults.get(tab.vault)!.entry(tab.id).path;
    setModal({
      title: "Save copy as",
      body: (
        <div className="vault-form">
          <label>
            Vault
            <LegacySelect
              aria-label="Copy destination vault"
              defaultValue={destination}
              onChange={(event) => {
                destination = event.target.value;
              }}
            >
              {vaults.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name}
                </option>
              ))}
            </LegacySelect>
          </label>
          <label>
            New file path
            <Input
              aria-label="Copy file path"
              defaultValue={path}
              onChange={(event) => {
                path = event.target.value;
              }}
            />
          </label>
          <p>
            The copy has a new file identity. Existing files are never
            overwritten.
          </p>
        </div>
      ),
      actions: (
        <>
          <Button variant="outline" onClick={() => setModal(undefined)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void execute(async () => {
                const id = await runtime.editors.saveCopy(
                    tab.vault,
                    tab.id,
                    destination,
                    path,
                    tab.session,
                  ),
                  vault = runtime.vaults.get(destination)!;
                setModal(undefined);
                await openFile(
                  vault,
                  vault.list().find((file) => file.id === id)!,
                );
              })
            }
          >
            Save copy
          </Button>
        </>
      ),
    });
  };
  const designatedTemplates = vaultTemplates(runtime);
  const templateSource = async (vault: FileVault, item: VaultTemplate) => {
    let source =
        item.vault && item.file
          ? runtime.vaults
              .get(item.vault)
              ?.list()
              .find((f) => f.id === item.file)
          : undefined,
      sourceVault = item.vault ? runtime.vaults.get(item.vault) : undefined;
    if (!source || !sourceVault)
      throw Error("The template source is not in an open vault");
    return { source, sourceVault };
  };
  const fromTemplate = async (
    vault: FileVault,
    folder: string,
    item: VaultTemplate,
    mode: "copy" | "reference",
  ) => {
    const { source, sourceVault } = await templateSource(vault, item);
    await sourceVault.load(source.id);
    const text = fileText(sourceVault.doc(source.id));
    await createAt(
      vault,
      folder,
      item.contentType ??
        (item.extension === ".csdb"
          ? "csdb"
          : item.extension === ".canvas"
            ? "canvas"
            : "markdown"),
      {
        text,
        extension: item.extension,
        mode,
        template: { hint: source.path, file: source.id, text },
      },
    );
  };
  const moveWithLinks = async (
    vault: FileVault,
    oldPath: string,
    newPath: string,
    folder = false,
  ) => {
    const moved = linkables.filter(
      (f) =>
        f.vault === vault.id &&
        (folder ? f.path.startsWith(oldPath + "/") : f.path === oldPath),
    );
    if (folder) await vault.moveFolder(oldPath, newPath);
    else {
      const file = vault.find(oldPath);
      if (file) await vault.move(file.id, newPath);
    }
    for (const source of linkables.filter(
      (f) =>
        f.vault === vault.id &&
        vault.list().find((file) => file.id === f.id)?.mime === "text/markdown",
    )) {
      const existing = latest.current.tabs.find(
        (t) => tabKey(t) === tabKey(source),
      );
      await vault.load(source.id);
      const savedText = fileText(vault.doc(source.id));
      let rewritten = existing?.draft.text ?? savedText;
      for (const target of moved)
        rewritten = rewriteMovedLinks(
          { ...source, text: rewritten },
          target,
          vault.entry(target.id).path,
          linkables,
        );
      if (rewritten === (existing?.draft.text ?? savedText)) continue;
      if (existing) {
        existing.draft.text = rewritten;
        runtime.editors.changed(vault.id, source.id);
      } else {
        const { draft } = await runtime.editors.open(vault.id, source.id);
        draft.text = rewritten;
        runtime.editors.changed(vault.id, source.id);
        setTabs((prior) =>
          prior.some((t) => tabKey(t) === tabKey(source))
            ? prior
            : [
                ...prior,
                {
                  vault: vault.id,
                  id: source.id,
                  draft,
                  handler: "markdown",
                  editorId: "core.markdown.editor",
                  pinned: false,
                },
              ],
        );
      }
    }
    pulse();
  };
  const commitInlineRename = async (name: string) => {
    const editing = inlineRename;
    if (!editing) return;
    setInlineRename(undefined);
    const vault = runtime.vaults.get(editing.vault)!;
    const parent = editing.path.split("/").slice(0, -1).join("/"),
      path = [parent, name.trim()].filter(Boolean).join("/");
    if (!name.trim() || path === editing.path) return;
    await moveWithLinks(vault, editing.path, path, editing.folder);
  };
  const menuBindings: MenuBindings = {
    items: (location, context) => {
      if (location === "explorer/open-with" && context.vault && context.id) {
        const vault = runtime.vaults.get(context.vault)!,
          file = vault.list().find((file) => file.id === context.id)!;
        const views = fileViews(vault, file);
        return [...new Set(views.map((view) => view.extension))].map(
          (extension) => ({
            id: "core.open-plugin." + extension,
            owner: "core",
            title: views.find((view) => view.extension === extension)!.plugin,
            location,
            icon: "Puzzle",
            children: views
              .filter((view) => view.extension === extension)
              .map((view) => ({
                id: "core.open-view." + view.id,
                owner: "core",
                title: view.title,
                location,
                command: "core.open-view." + view.id,
                icon: view.icon,
              })),
          }),
        );
      }
      return [
        ...runtime.extensions.menuContributions(location, context),
        ...(location === "editor/toolbar"
          ? runtime.extensions.menuContributions("toolbar", context)
          : []),
      ];
    },
    execute: (item, context) => {
      if (
        item.owner === "core" &&
        item.command?.startsWith("core.open-view.")
      ) {
        const vault = runtime.vaults.get(context.vault!)!,
          file = vault.list().find((file) => file.id === context.id)!;
        void execute(() =>
          finishOpen(
            vault,
            file,
            item.command!.slice("core.open-view.".length),
          ),
        );
        return;
      }
      if (item.owner === "core") {
        const handler = coreActions[item.command ?? ""];
        if (handler) void execute(async () => handler(context));
      } else if (item.command)
        void execute(() =>
          runtime.extensions.executeCommand(item.command!, context),
        );
    },
  };
  const explorerActions = {
    menu: menuBindings,
    newFile: (vault: FileVault, folder: string, type: string) =>
      void execute(() => createAt(vault, folder, type)),
    newFolder: (vault: FileVault, folder: string) =>
      void execute(async () => {
        setTypeFilter("");
        let index = 0,
          path: string;
        do {
          path = [folder, "New folder" + (index ? " " + index : "")]
            .filter(Boolean)
            .join("/");
          index++;
        } while (vault.directories().includes(path));
        await vault.createFolder(path);
        setInlineRename({ vault: vault.id, path, folder: true, fresh: true });
      }),
    template: (
      vault: FileVault,
      folder: string,
      item: VaultTemplate,
      mode: "copy" | "reference",
    ) => void execute(() => fromTemplate(vault, folder, item, mode)),
    rename: (vault: FileVault, path: string, file?: FileSummary) =>
      setInlineRename({ vault: vault.id, path, folder: !file }),
    remove: (vault: FileVault, path: string, file?: FileSummary) =>
      setModal({
        title: file ? "Delete file?" : "Delete folder?",
        body: (
          <p>
            {path}
            {!file && " and all its contents"}
          </p>
        ),
        actions: (
          <>
            <Button variant="outline" onClick={() => setModal(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void execute(async () => {
                  const affected = file
                    ? [file]
                    : vault.list().filter((f) => f.path.startsWith(path + "/"));
                  const sessions = [
                    ...runtime.editors.sessions.values(),
                  ].filter(
                    (session) =>
                      session.vault === vault.id &&
                      affected.some((file) => file.id === session.id),
                  );
                  if (sessions.some((session) => session.draft.dirty))
                    throw Error("Save or discard edits before deleting");
                  if (file) await vault.remove(file.id);
                  else await vault.removeFolder(path);
                  for (const session of sessions)
                    await runtime.editors.close(
                      vault.id,
                      session.id,
                      true,
                      session.instance,
                    );
                  setTabs((prior) =>
                    prior.filter(
                      (tab) =>
                        !sessions.some(
                          (session) =>
                            tab.vault === session.vault &&
                            tab.id === session.id,
                        ),
                    ),
                  );
                  setModal(undefined);
                })
              }
            >
              Delete
            </Button>
          </>
        ),
      }),
    designate: (vault: FileVault, file: FileSummary) =>
      void execute(() =>
        vault.setTemplate(file.path, file.path.split("/").pop()!),
      ),
  };
  const template = (tab: Tab) => {
    const vault = runtime.vaults.get(tab.vault)!,
      extension = "." + vault.entry(tab.id).path.split(".").pop(),
      options = designatedTemplates.filter(
        (t) => t.enabled !== false && t.extension === extension,
      );
    let selected = options[0]?.id ?? "",
      mode: "copy" | "reference" = "copy";
    setModal({
      title: "Apply a template",
      body: (
        <div className="space-y-3">
          {options.length ? (
            <>
              <label>
                Template
                <LegacySelect
                  aria-label="Template"
                  defaultValue={selected}
                  onChange={(e) => {
                    selected = e.target.value;
                  }}
                >
                  {options.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </LegacySelect>
              </label>
              <label>
                Template mode
                <LegacySelect
                  defaultValue="copy"
                  onChange={(e) => {
                    mode = e.target.value as "copy" | "reference";
                  }}
                >
                  <option value="copy">Copy once</option>
                  <option value="reference">Reference source file</option>
                </LegacySelect>
              </label>
              <p className="text-sm text-muted-foreground">
                Referenced templates check for updates only when this file
                opens. Changes require Save.
              </p>
            </>
          ) : (
            <p>
              Designate a source file in the file browser, or add a template in
              plugin settings.
            </p>
          )}
        </div>
      ),
      actions: (
        <>
          <Button variant="outline" onClick={() => setModal(undefined)}>
            Cancel
          </Button>
          <Button
            disabled={!options.length}
            onClick={() =>
              void execute(async () => {
                const item = options.find((t) => t.id === selected);
                if (!item) return;
                const { source, sourceVault } = await templateSource(
                  vault,
                  item,
                );
                await sourceVault.load(source.id);
                applyTemplate(
                  tab.draft,
                  {
                    hint: source.path,
                    file: source.id,
                    text: fileText(sourceVault.doc(source.id)),
                  },
                  mode,
                );
                runtime.editors.changed(tab.vault, tab.id, "edit", tab.session);
                setModal(undefined);
              })
            }
          >
            Apply to draft
          </Button>
        </>
      ),
    });
  };
  const showHistory = (
    tab: Pick<Tab, "vault" | "id"> & { session?: string },
  ) => {
    const vault = runtime.vaults.get(tab.vault)!;
    setModal({
      title: "History",
      feature: "history",
      wide: true,
      body: (
        <Suspense fallback={<p>Loading history…</p>}>
          <FileHistory
            onOpen={(target) => openFeatureTarget(target, "history")}
            key={crypto.randomUUID()}
            vault={vault}
            id={tab.id}
            runtime={runtime}
            restore={(heads) =>
              void execute(async () => {
                let target = tab;
                if (!runtime.editors.sessions.has(tabKey(target))) {
                  await openFile(
                    vault,
                    vault.list().find((file) => file.id === tab.id)!,
                  );
                  target = latest.current.tabs.find(
                    (item) => item.vault === tab.vault && item.id === tab.id,
                  )!;
                }
                const draft = runtime.editors.replace(
                  target.vault,
                  target.id,
                  vault.restore(target.id, heads),
                  target.session,
                );
                setTabs((prior) =>
                  prior.map((item) =>
                    tabKey(item) === tabKey(target) ? { ...item, draft } : item,
                  ),
                );
                setModal(undefined);
              })
            }
            recovered={async (id) => {
              setModal(undefined);
              await openFile(
                vault,
                vault.list().find((file) => file.id === id)!,
              );
              pulse();
            }}
          />
        </Suspense>
      ),
    });
  };
  const recoverDeleted = (vault: FileVault) =>
    setModal({
      title: "Deleted file recovery",
      body: (
        <div className="vault-list">
          {vault.deletedFiles().map((file) => (
            <Button
              variant="outline"
              key={file.id}
              onClick={() => showHistory({ vault: vault.id, id: file.id })}
            >
              {file.path}
            </Button>
          ))}
          {!vault.deletedFiles().length && (
            <p>No deleted files with retained history.</p>
          )}
        </div>
      ),
    });
  const featureContext = (context: MenuContext) => {
    if (!context.vault)
      return {
        ...context,
        kind: "workspace" as const,
        ...runtime.workspace.features,
      };
    const vault = runtime.vaults.get(context.vault)!;
    return {
      ...explorerContext(
        vault,
        context.path ?? "",
        context.id ? { id: context.id } : undefined,
      ),
      instance: context.instance,
    };
  };
  const configureFeature = async (
    context: MenuContext,
    feature: "history" | "sync",
    enabled: boolean,
  ) => {
    if (!context.vault)
      await runtime.configureWorkspace({ [feature]: enabled });
    else
      await runtime.configureScope(
        runtime.vaults.get(context.vault)!,
        context.id ? "file" : context.path ? "folder" : "vault",
        context.id ?? context.path ?? "",
        { [feature]: enabled },
      );
    pulse();
  };
  const openFeatureTarget = (
    target: FeatureTarget,
    feature: "history" | "sync",
  ) => {
    void execute(() =>
      openFeature(
        target.vault
          ? explorerContext(
              target.vault,
              target.path ??
                (target.id ? target.vault.entry(target.id).path : ""),
              target.id ? { id: target.id } : undefined,
            )
          : { kind: "workspace" },
        feature,
        false,
      ),
    );
  };
  const openFeature = async (
    context: MenuContext,
    feature: "history" | "sync",
    enable = true,
  ) => {
    context = featureContext(context);
    if (enable && !context[feature])
      await configureFeature(context, feature, true);
    const vault = context.vault
      ? runtime.vaults.get(context.vault)!
      : undefined;
    if (feature === "history" && vault && context.id) {
      showHistory({
        vault: vault.id,
        id: context.id,
        session: context.instance,
      });
      return;
    }
    if (feature === "history") {
      setModal({
        title: "History",
        feature: "history",
        wide: true,
        body: (
          <VaultScopeHistory
            key={crypto.randomUUID()}
            runtime={runtime}
            vault={vault}
            path={context.path}
            onOpen={(target) => openFeatureTarget(target, "history")}
          />
        ),
      });
      return;
    }
    setModal({
      title: "Sharing",
      feature: "sync",
      wide: true,
      body: (
        <VaultSharing
          key={crypto.randomUUID()}
          onOpen={(target) => openFeatureTarget(target, "sync")}
          runtime={runtime}
          vault={vault}
          file={context.path}
          folder={context.kind === "folder"}
        />
      ),
    });
  };
  const commands = [
    {
      id: "save",
      label: "Save file",
      shortcut: "Mod+s",
      run: () => current && void execute(() => save(current)),
    },
    {
      id: "switch",
      label: "Quick switcher",
      shortcut: "Mod+o",
      run: () => {
        setQuery("");
        openAppPage("search");
      },
    },
    {
      id: "search",
      label: "Search all vaults",
      shortcut: "Mod+Shift+f",
      run: () => openAppPage("search"),
    },
    { id: "new", label: "New file", shortcut: "Mod+n", run: () => newFile() },
    {
      id: "close",
      label: "Close tab",
      shortcut: "Mod+w",
      run: () => current && close(current),
    },
    {
      id: "graph",
      label: "Open graph",
      shortcut: "Mod+g",
      run: () => openAppPage("graph"),
    },
    {
      id: "split",
      label: "Split editor",
      shortcut: "Mod+\\",
      run: () =>
        current &&
        paneAPI.current?.split({
          file: tabKey(current),
          view: current.view ?? "edit",
        }),
    },
    {
      id: "vaults",
      label: "Manage vaults",
      shortcut: "",
      run: () => openAppPage("workspace"),
    },
    {
      id: "settings",
      label: "Workspace settings",
      shortcut: "Mod+,",
      run: () => setSettingsOpen(true),
    },
    {
      id: "template",
      label: "Apply template",
      shortcut: "",
      run: () => current && template(current),
    },
    {
      id: "rename",
      label: "Move or rename file",
      shortcut: "F2",
      run: () => current && rename(current),
    },
    {
      id: "share",
      label: "Open sharing",
      shortcut: "",
      run: () =>
        void execute(() =>
          openFeature(
            current
              ? {
                  ...explorerContext(
                    runtime.vaults.get(current.vault)!,
                    runtime.vaults.get(current.vault)!.entry(current.id).path,
                    { id: current.id },
                  ),
                  instance: current.session,
                }
              : { kind: "workspace" },
            "sync",
          ),
        ),
    },
    ...runtime.extensions.commandContributions().map((command) => ({
      id: command.id,
      label: command.title,
      shortcut:
        runtime.extensions
          .manifests()
          .flatMap((m) => m.contributes.keybindings)
          .find((k) => k.command === command.id)?.key ?? "",
      run: () =>
        void execute(async () => {
          await runtime.extensions.executeCommand(command.id);
        }),
    })),
  ];
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setModal({
          title: "Commands",
          body: (
            <div className="vault-list">
              {menuBindings.items("commandPalette", toolbarContext).map((c) => (
                <Button
                  variant="outline"
                  key={c.id}
                  onClick={() => {
                    setModal(undefined);
                    menuBindings.execute(c, toolbarContext);
                  }}
                >
                  {c.title}
                </Button>
              ))}
            </div>
          ),
        });
        return;
      }
      const pressed =
        (mod ? "Mod+" : "") +
        (event.shiftKey ? "Shift+" : "") +
        (event.altKey ? "Alt+" : "") +
        event.key.toLowerCase();
      const command = commands.find(
        (c) =>
          (settings.hotkeys[c.id] ?? c.shortcut).toLowerCase() ===
          pressed.toLowerCase(),
      );
      if (command) {
        event.preventDefault();
        command.run();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    const value =
      settingsTarget === "defaults"
        ? runtime.workspace.current.defaults
        : (runtime.workspace.current.computers[settingsTarget] ??
          emptyOverrides());
    setSettingsJSON(JSON.stringify(value, null, 2));
  }, [settingsTarget, settingsOpen]);
  const editor = (tab: Tab, focused = true) => {
    const vault = runtime.vaults.get(tab.vault)!,
      entry = vault.entry(tab.id);
    const changed = (value: string) => {
      tab.draft.text = value;
      runtime.editors.changed(tab.vault, tab.id, "edit", tab.session);
    };
    let body: ReactNode;
    if (
      [
        "sql",
        "columns",
        "history",
        "sharing",
        "properties",
        "outline",
        "links",
        "tags",
      ].includes(tab.handler)
    )
      body = auxiliaryView(tab, tab.handler as DockView, focused);
    else if (tab.webview && tab.editorId)
      body = (
        <ExtensionWebview
          runtime={runtime}
          vault={tab.vault}
          id={tab.id}
          editorId={tab.editorId}
          instance={tab.session}
          html={tab.webview}
          revision={revision}
        />
      );
    else if (tab.handler === "markdown")
      body = (
        <VaultMarkdownEditor
          key={tabKey(tab)}
          value={tab.draft.text}
          onChange={changed}
          context={markdownContext(tab)}
          vimMode={settings.vim}
          reveal={tab.reveal}
        />
      );
    else if (tab.handler === "csdb-form")
      body = (
        <CSDBAttributeForm
          session={(tab.formSession ??= {})}
          value={tab.draft.text}
          tasks={tab.draft.contentType === "jocki.task-list"}
          imported={tab.imported}
          onChange={changed}
          onState={(state) => {
            const pending = !!tab.form?.pending;
            tab.form = state;
            if (pending !== !!state?.pending) pulse();
          }}
          tools={(controls) =>
            focused && active === tabKey(tab) && desktopControls
              ? createPortal(controls, desktopControls)
              : controls
          }
        />
      );
    else if (tab.handler === "csdb" || tab.handler === "tasks")
      body = (
        <VaultCollectionEditor
          value={tab.draft.text}
          baseline={fileText(tab.draft.original)}
          canDescribe={vault.historyEnabled(tab.id)}
          metadataDirty={
            canonical(tab.draft.resource) !==
            canonical(tab.draft.original.resource)
          }
          onSaveRows={async (table, ids, description, metadata) => {
            await save(tab, description, { table, ids, metadata });
          }}
          onChange={changed}
          tasks={tab.handler === "tasks"}
          preferences={
            tab.draft.resource?.saddle?.collectionView as unknown as
              Partial<CollectionViewState> | undefined
          }
          onPreferences={(state) => {
            tab.draft.resource ??= newResource(tab.draft.path);
            tab.draft.resource.saddle ??= {};
            tab.draft.resource.saddle.collectionView = JSON.parse(
              JSON.stringify(state),
            );
            runtime.editors.changed(tab.vault, tab.id, "edit", tab.session);
          }}
          tools={(controls) =>
            focused && tabKey(tab) === active ? (
              <>{desktopControls && createPortal(controls, desktopControls)}</>
            ) : (
              controls
            )
          }
        />
      );
    else if (tab.handler === "canvas")
      body = (
        <CanvasEditor
          value={tab.draft.text}
          onChange={changed}
          open={(target) => openLink(tab, target)}
        />
      );
    else if (vault.doc(tab.id).kind === "text")
      body = (
        <Suspense fallback={<p>Loading editor…</p>}>
          <CodeEditor
            path={`${tab.vault}/${entry.path}`}
            value={tab.draft.text}
            onChange={changed}
            complete={(offset, token) =>
              runtime.extensions.completionsFor(
                runtime.editors.snapshot(tab.vault, tab.id, tab.session),
                offset,
                token,
              )
            }
          />
        </Suspense>
      );
    else {
      const preview = asset(tab, entry.path),
        mime = tab.draft.mime;
      body = (
        <div className="vault-media">
          {mime.startsWith("image/") ? (
            <img src={preview?.url} alt={entry.path} />
          ) : mime.startsWith("audio/") ? (
            <audio controls src={preview?.url} />
          ) : mime.startsWith("video/") ? (
            <video controls src={preview?.url} />
          ) : mime === "application/pdf" ? (
            <iframe title={entry.path} src={preview?.url} sandbox="" />
          ) : (
            <p>Binary file · {tab.draft.bytes.length.toLocaleString()} bytes</p>
          )}
          <a href={preview?.url} download={entry.path.split("/").pop()}>
            Download file
          </a>
          <label>
            Replace contents
            <Input
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void file.arrayBuffer().then((bytes) => {
                    tab.draft.bytes = new Uint8Array(bytes);
                    runtime.editors.changed(
                      tab.vault,
                      tab.id,
                      "edit",
                      tab.session,
                    );
                  });
              }}
            />
          </label>
        </div>
      );
    }
    return (
      <section className="vault-editor-pane" key={tabKey(tab)}>
        <div className="vault-document-bar" data-document-bar>
          <nav
            aria-label="File path"
            data-file-breadcrumb
            className="vault-document-path"
          >
            <ContributionContextMenu
              bindings={menuBindings}
              context={explorerContext(vault, "")}
            >
              <ExplorerMenu
                vault={vault}
                path=""
                actions={explorerActions}
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-1 text-xs"
                  >
                    {vault.name}
                  </Button>
                }
              />
            </ContributionContextMenu>
            {entry.path.split("/").map((part, index, parts) => {
              const path = parts.slice(0, index + 1).join("/"),
                file = index === parts.length - 1 ? entry : undefined;
              return (
                <span key={path} className="flex shrink-0 items-center gap-1">
                  <span>/</span>
                  <ContributionContextMenu
                    bindings={menuBindings}
                    context={explorerContext(vault, path, file)}
                  >
                    <ExplorerMenu
                      vault={vault}
                      path={path}
                      file={file}
                      actions={explorerActions}
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-1 text-xs"
                          aria-label={`Path menu: ${path}`}
                        >
                          {part}
                        </Button>
                      }
                    />
                  </ContributionContextMenu>
                </span>
              );
            })}
          </nav>
          <nav
            aria-label="Document toolbar"
            data-document-toolbar
            className="vault-document-tools"
          >
            <IconButton
              label="Discard"
              disabled={!tabDirty(tab)}
              onClick={() =>
                void execute(async () => {
                  discard(tab);
                })
              }
            >
              <Undo2 />
            </IconButton>
            {focused && tabKey(tab) === active && (
              <div ref={setDesktopControls} className="flex shrink-0 gap-1" />
            )}
            {[
              ...menuBindings.items(
                "editor/toolbar",
                explorerContext(vault, entry.path, entry),
              ),
              ...menuBindings.items(
                "editor/title",
                explorerContext(vault, entry.path, entry),
              ),
            ]
              .filter(
                (item, index, items) =>
                  items.findIndex(
                    (candidate) => candidate.command === item.command,
                  ) === index,
              )
              .map((item) => (
                <ToolbarContribution
                  key={item.id}
                  item={item}
                  bindings={menuBindings}
                  context={{
                    ...explorerContext(vault, entry.path, entry),
                    instance: tab.session,
                  }}
                />
              ))}
            {tab.handler !== "tasks" && (
              <SaveStatusButton
                dirty={tabDirty(tab)}
                disabled={busy}
                canDescribe={vault.historyEnabled(tab.id)}
                onSave={(description) => save(tab, description)}
              />
            )}
          </nav>
        </div>
        <div className="vault-editor-body">{body}</div>
      </section>
    );
  };
  const csdbImportConfiguration = runtime.workspace.settings(runtime.computer)
    .plugins["core.csdb"];
  const csdbImportState = useMemo(() => {
    try {
      return { settings: readCSDBImportSettings(csdbImportConfiguration) };
    } catch (error) {
      return { settings: { profiles: [], default_profile: "" }, error };
    }
  }, [csdbImportConfiguration]);
  useEffect(() => {
    if (csdbImportState.error) logError(csdbImportState.error, "csdb-settings");
  }, [csdbImportState]);
  const csdbImports = csdbImportState.settings;
  const importCSDB = async (
    context: MenuContext,
    profile: CSDBImportProfile,
    sources: string[],
  ) => {
    const vault = runtime.vaults.get(context.vault!)!,
      file = vault.list().find((file) => file.id === context.id)!;
    if (!file || file.mime !== "application/vnd.csdb")
      throw Error("Choose a CSDB destination file");
    const apply = (draft: Draft) => {
      const result = mergeCSDBImport(draft.text, sources, profile);
      validateCSDBType(
        result.text,
        contentTypes.find((type) => type.id === draft.contentType),
      );
      return result;
    };
    if (profile.view === "autosave") {
      if (
        latest.current.tabs.some(
          (tab) =>
            tab.vault === vault.id && tab.id === file.id && tabDirty(tab),
        ) ||
        [...runtime.editors.sessions.values()].some(
          (session) =>
            session.vault === vault.id &&
            session.id === file.id &&
            session.draft.dirty,
        )
      )
        throw Error(
          "Save or discard this file's drafts before importing automatically",
        );
      await vault.load(file.id);
      const draft = vault.draft(file.id);
      try {
        const result = apply(draft);
        draft.text = result.text;
        await vault.save(
          draft,
          vault.historyEnabled(file.id) ? "Import CSDB data" : "",
        );
        for (const report of result.reports)
          for (const warning of report.warnings)
            logger("csdb-import").warn("{warning}", { warning });
      } finally {
        vault.release(draft);
      }
      setModal(undefined);
      pulse();
      return;
    }
    const tab = await finishOpen(
      vault,
      file,
      profile.view === "form"
        ? "core.csdb.form"
        : file.contentType === "jocki.task-list"
          ? "tasks.editor"
          : "core.csdb.editor",
    );
    flushForm(tab);
    const result = apply(tab.draft);
    tab.draft.text = result.text;
    runtime.editors.changed(tab.vault, tab.id, "edit", tab.session);
    if (profile.view === "form") {
      tab.imported = { token: crypto.randomUUID(), rows: result.rows };
      setTabs((prior) =>
        prior.map((item) =>
          tabKey(item) === tabKey(tab)
            ? { ...item, imported: tab.imported }
            : item,
        ),
      );
    }
    for (const report of result.reports)
      for (const warning of report.warnings)
        logger("csdb-import").warn("{warning}", { warning });
    setModal(undefined);
    pulse();
  };
  const chooseCSDB = (context: MenuContext, profile: CSDBImportProfile) => {
    const roots: PickerRoot[] = [...runtime.vaults.values()].map((vault) => ({
      id: vault.id,
      name: vault.name,
      entries: [
        ...vault
          .directories()
          .map((path) => ({ id: path, path, kind: "folder" as const })),
        ...vault.list().map((file) => ({
          id: file.id,
          path: file.path,
          kind: "file" as const,
          read: async () => {
            await vault.load(file.id);
            return fileBytes(vault.doc(file.id));
          },
        })),
      ],
    }));
    setModal({
      title: "Add CSDB data · " + profile.name,
      wide: true,
      body: (
        <FilePicker
          roots={roots}
          options={{ kind: "file", extensions: [".csdb"], multiple: true }}
          onCancel={() => setModal(undefined)}
          onChoose={async (files) => {
            const sources = await Promise.all(
              files.map(async (file) => {
                if (!file.read) throw Error("Cannot read selected file");
                return new TextDecoder("utf-8", { fatal: true }).decode(
                  await file.read(),
                );
              }),
            );
            await importCSDB(context, profile, sources);
          }}
        />
      ),
    });
  };
  const coreActions: Record<string, (context: MenuContext) => unknown> = {
    "core.recheck-metadata": (context) =>
      runtime.vaults.get(context.vault!)!.recheckMetadata(context.id!),
    "core.history": (context) => openFeature(context, "history"),
    "core.share": (context) => openFeature(context, "sync"),
    "core.new-folder": (c) =>
      explorerActions.newFolder(runtime.vaults.get(c.vault!)!, c.path ?? ""),
    "core.rename": (c) =>
      explorerActions.rename(
        runtime.vaults.get(c.vault!)!,
        c.path ?? "",
        c.id
          ? runtime.vaults
              .get(c.vault!)!
              .list()
              .find((f) => f.id === c.id)!
          : undefined,
      ),
    "core.delete": (c) =>
      explorerActions.remove(
        runtime.vaults.get(c.vault!)!,
        c.path ?? "",
        c.id
          ? runtime.vaults
              .get(c.vault!)!
              .list()
              .find((f) => f.id === c.id)!
          : undefined,
      ),
    "core.designate-template": (c) =>
      explorerActions.designate(
        runtime.vaults.get(c.vault!)!,
        runtime.vaults
          .get(c.vault!)!
          .list()
          .find((f) => f.id === c.id)!,
      ),
    "core.new-workspace": () => {
      let name = "New workspace";
      setModal({
        title: "New workspace",
        body: (
          <label>
            Name
            <Input
              aria-label="Workspace name"
              defaultValue={name}
              onChange={(e) => (name = e.target.value)}
            />
          </label>
        ),
        actions: (
          <Button
            onClick={() => changeWorkspace(() => runtime.createWorkspace(name))}
          >
            Create workspace
          </Button>
        ),
      });
    },
  };
  for (const profile of csdbImports.profiles) {
    coreActions["core.csdb.choose." + profile.id] = (context) =>
      chooseCSDB(context, profile);
    for (const template of designatedTemplates.filter(
      (template) =>
        template.enabled !== false &&
        template.extension.toLowerCase() === ".csdb",
    ))
      coreActions[`core.csdb.template.${profile.id}.${template.id}`] = async (
        context,
      ) => {
        let source = template.text;
        if (template.vault && template.file) {
          const vault = runtime.vaults.get(template.vault)!;
          await vault.load(template.file);
          source = fileText(vault.doc(template.file));
        }
        if (source === undefined)
          throw Error("The selected template is unavailable");
        source = instantiateCSDBTemplate(source);
        await importCSDB(context, profile, [source]);
      };
  }
  for (const id of [
    "workspace",
    "templates",
    "graph",
    "search",
    "sharing",
    "plugins",
    "csdb",
    "shortcuts",
    "logs",
    ...runtime.extensions.installed().map((e) => "plugin:" + e.manifest.id),
  ])
    coreActions["core.page." + id.replace("plugin:", "plugin.")] = () =>
      openAppPage(id);
  for (const type of [
    "markdown",
    "text",
    "csdb",
    "canvas",
    ...contentTypes.map((t) => t.id),
  ])
    coreActions["core.create." + type] = (c) =>
      explorerActions.newFile(
        runtime.vaults.get(c.vault!)!,
        c.path ?? "",
        type,
      );
  for (const item of designatedTemplates)
    for (const mode of ["copy", "link"] as const)
      coreActions["core.template." + mode + "." + item.id] = (c) =>
        explorerActions.template(
          runtime.vaults.get(c.vault!)!,
          c.path ?? "",
          item,
          mode === "copy" ? "copy" : "reference",
        );
  for (const id of ["copy", "rename", "template", "bookmark", "pin", "popout"])
    coreActions["core.editor." + id] = async (c) => {
      const tab = latest.current.tabs.find(
        (t) =>
          t.vault === c.vault &&
          t.id === c.id &&
          (c.instance
            ? t.session === c.instance
            : tabKey(t) === active ||
              !latest.current.tabs.some(
                (tab) =>
                  tab.vault === c.vault &&
                  tab.id === c.id &&
                  tabKey(tab) === active,
              )),
      );
      if (!tab) return;
      if (id === "copy") return saveCopy(tab);
      if (id === "rename") return rename(tab);
      if (id === "template") return template(tab);
      if (id === "bookmark")
        return runtime.workspace.update((d) => {
          const b = d.defaults.layout.bookmarks,
            key = fileKey(tab),
            index = b.indexOf(key);
          if (index < 0) b.push(key);
          else b.splice(index, 1);
        });
      if (id === "pin")
        return setTabs((prior) =>
          prior.map((t) =>
            tabKey(t) === tabKey(tab) ? { ...t, pinned: !t.pinned } : t,
          ),
        );
      const entry = runtime.vaults.get(tab.vault)!.entry(tab.id);
      const child = window.open(
        "about:blank",
        "_blank",
        "popup,width=1050,height=750",
      );
      if (!child) {
        setError("The pop-out window could not open");
        return;
      }
      child.document.title = entry.path;
      for (const style of document.querySelectorAll(
        'style,link[rel="stylesheet"]',
      ))
        child.document.head.append(style.cloneNode(true));
      child.addEventListener("beforeunload", (e) => {
        if (tabDirty(tab)) {
          e.preventDefault();
          e.returnValue = "";
        }
      });
      child.addEventListener("unload", () =>
        setTabs((prior) =>
          prior.map((t) =>
            tabKey(t) === tabKey(tab) ? { ...t, popout: undefined } : t,
          ),
        ),
      );
      setTabs((prior) =>
        prior.map((t) =>
          tabKey(t) === tabKey(tab) ? { ...t, popout: child } : t,
        ),
      );
    };
  const pluginCommands = new Set(
    runtime.extensions.commandContributions().map((c) => c.id),
  );
  for (const command of commands.filter((c) => !pluginCommands.has(c.id)))
    coreActions["core.palette." + command.id] = () => command.run();
  registerCoreMenus(
    runtime.extensions.ui,
    runtime.installedContentTypes(),
    designatedTemplates,
    runtime.extensions
      .installed()
      .map((e) => ({ id: e.manifest.id, name: e.manifest.name })),
    commands.filter((c) => !pluginCommands.has(c.id)),
    csdbImports,
  );
  const hits =
    navigation === "core.navigation.search" || active === "app:search"
      ? query.trim()
        ? search.current.search(query)
        : []
      : [];
  const graphData = useMemo(
    () =>
      active === "app:graph" || navigation === "core.navigation.graph"
        ? graph(
            linkables.filter(
              (f) =>
                !graphFilter ||
                f.path.includes(graphFilter) ||
                (f.metadataTerms ?? []).some((term) =>
                  term.includes(graphFilter),
                ),
            ),
            graphLocal ? lastDocument.current : undefined,
            depth,
            {
              links: graphLinks,
              metadata: graphMetadata,
              hierarchy: graphHierarchy,
            },
          )
        : { files: [], edges: [] },
    [
      vaultSignature,
      graphFilter,
      graphLocal,
      depth,
      active,
      navigation,
      graphLinks,
      graphMetadata,
      graphHierarchy,
    ],
  );
  const graphNodes: Node[] = graphData.files.map((f, i, all) => ({
    id: tabKey(f),
    position: {
      x: Math.cos((i * Math.PI * 2) / all.length) * 350,
      y: Math.sin((i * Math.PI * 2) / all.length) * 350,
    },
    data: { label: f.path.split("/").pop() },
    style: {
      borderColor: noteMetadata(f.text).tags.length ? "#4c8d78" : "#6366a0",
      borderRadius: 30,
    },
  }));
  const graphEdges: Edge[] = graphData.edges.map((e, i) => ({
    id: String(i),
    source: e.from,
    target: e.to,
    style: {
      stroke:
        e.kind === "metadata"
          ? "#b17924"
          : e.kind === "hierarchy"
            ? "#7c8594"
            : "#6366a0",
    },
  }));
  const inspector = (current: Tab, rightPanel: DockView) => {
    const meta =
      current.draft.mime === "text/markdown"
        ? noteMetadata(current.draft.text)
        : undefined;
    return (
      <section className="space-y-3 p-4 vault-document-inspector">
        {" "}
        {rightPanel === "outline" && (
          <>
            {meta?.headings.map((h, i) => (
              <Button
                variant="ghost"
                key={i}
                style={{ paddingLeft: `${h.level}ch` }}
                onClick={() => {
                  setTabs((prior) =>
                    prior.map((t) =>
                      t === current ? { ...t, reveal: h.text } : t,
                    ),
                  );
                }}
              >
                {h.text}
              </Button>
            ))}
            {Object.keys(meta?.footnotes ?? {}).length > 0 && (
              <h3>Footnotes</h3>
            )}
            {Object.entries(meta?.footnotes ?? {}).map(([id, value]) => (
              <p key={id}>
                [{id}] {value}
              </p>
            ))}
          </>
        )}
        {rightPanel === "properties" && (
          <>
            <label className="grid gap-2 text-sm">
              Content type
              <LegacySelect
                aria-label="Content type"
                value={current.draft.contentType ?? ""}
                onChange={(e) => {
                  void execute(async () => {
                    const contentType = e.target.value || null;
                    const candidate = {
                      ...runtime.editors.snapshot(
                        current.vault,
                        current.id,
                        current.session,
                      ),
                      contentType,
                    };
                    validateType(candidate, contentTypes);
                    if (
                      contentType &&
                      candidate.mime === "application/vnd.csdb"
                    )
                      validateCSDBType(
                        candidate.text,
                        contentTypes.find((t) => t.id === contentType),
                      );
                    current.draft.contentType = contentType;
                    runtime.editors.changed(
                      current.vault,
                      current.id,
                      "edit",
                      current.session,
                    );
                    pulse();
                  });
                }}
              >
                <option value="">No content type</option>
                {runtime
                  .installedContentTypes()
                  .filter((t) => t.mimeTypes.includes(current.draft.mime))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </LegacySelect>
            </label>
            <VaultMetadataEditor
              draft={current.draft}
              path={runtime.vaults.get(current.vault)!.entry(current.id).path}
              changed={() => {
                runtime.editors.changed(
                  current.vault,
                  current.id,
                  "edit",
                  current.session,
                );
                pulse();
              }}
            />
            {current.draft.mime === "text/markdown" && (
              <Properties
                value={current.draft.text}
                change={(value) => {
                  current.draft.text = value;
                  runtime.editors.changed(
                    current.vault,
                    current.id,
                    "edit",
                    current.session,
                  );
                }}
              />
            )}
          </>
        )}
        {rightPanel === "tags" && (
          <div className="vault-list">
            {[...new Set(linkables.flatMap((f) => noteMetadata(f.text).tags))]
              .sort()
              .map((tag) => (
                <Button
                  variant="ghost"
                  key={tag}
                  onClick={() => {
                    setQuery("metadata:" + tag);
                    openAppPage("search");
                  }}
                >
                  #{tag}
                </Button>
              ))}
          </div>
        )}
        {rightPanel === "links" && (
          <>
            <h3>Outgoing</h3>
            {meta?.links.map((l, i) => (
              <Button
                variant="ghost"
                key={i}
                title={asset(current, l.target)?.text?.slice(0, 400)}
                onClick={() => openLink(current, l.target)}
              >
                {l.target}
              </Button>
            ))}
            <h3>Backlinks</h3>
            {linkables
              .filter((f) =>
                noteMetadata(f.text).links.some((l) =>
                  resolveLink(l.target, f, linkables).some(
                    (t) => fileKey(t) === fileKey(current),
                  ),
                ),
              )
              .map((f) => (
                <Button
                  variant="ghost"
                  key={tabKey(f)}
                  onClick={() =>
                    void execute(() =>
                      openFile(
                        runtime.vaults.get(f.vault)!,
                        runtime.vaults
                          .get(f.vault)!
                          .list()
                          .find((e) => e.id === f.id)!,
                      ),
                    )
                  }
                >
                  {f.path}
                </Button>
              ))}
            <h3>Unlinked mentions</h3>
            {linkables
              .filter(
                (f) =>
                  fileKey(f) !== fileKey(current) &&
                  f.text
                    .toLowerCase()
                    .includes(
                      runtime.vaults
                        .get(current.vault)!
                        .entry(current.id)
                        .path.split("/")
                        .pop()!
                        .replace(/\.md$/, "")
                        .toLowerCase(),
                    ) &&
                  !noteMetadata(f.text).links.some((l) =>
                    resolveLink(l.target, f, linkables).some(
                      (t) => fileKey(t) === fileKey(current),
                    ),
                  ),
              )
              .map((f) => (
                <Button
                  variant="ghost"
                  key={tabKey(f)}
                  onClick={() =>
                    void execute(() =>
                      openFile(
                        runtime.vaults.get(f.vault)!,
                        runtime.vaults
                          .get(f.vault)!
                          .list()
                          .find((e) => e.id === f.id)!,
                      ),
                    )
                  }
                >
                  {f.path}
                </Button>
              ))}
          </>
        )}
      </section>
    );
  };
  const renderPane = (
    tab: Tab,
    part: DockView,
    focused: boolean,
  ): ReactNode => {
    if (part === tab.view || part === "edit") return editor(tab, focused);
    if (part.startsWith("plugin:"))
      return (
        <ExtensionDocumentView
          runtime={runtime}
          file={tab}
          editor={part.slice(7)}
          revision={revision}
          renderComponent={(component) =>
            editor(
              {
                ...tab,
                handler: component,
                webview: undefined,
                editorId: part.slice(7),
              },
              focused,
            )
          }
        />
      );
    return editor({ ...tab, handler: part, webview: undefined }, focused);
  };
  const auxiliaryView = (
    tab: Tab,
    part: DockView,
    focused: boolean,
  ): ReactNode => {
    const vault = runtime.vaults.get(tab.vault)!;
    if (part === "sql")
      return (
        <VaultSQLView
          value={tab.draft.text}
          onChange={(value) => {
            tab.draft.text = value;
            runtime.editors.changed(tab.vault, tab.id, "edit", tab.session);
            pulse();
          }}
        />
      );
    if (part === "history")
      return vault.historyEnabled(tab.id) ? (
        <Suspense fallback={<p>Loading history…</p>}>
          <FileHistory
            onOpen={(target) => openFeatureTarget(target, "history")}
            vault={vault}
            id={tab.id}
            runtime={runtime}
            restore={(heads) => {
              const draft = runtime.editors.replace(
                tab.vault,
                tab.id,
                vault.restore(tab.id, heads),
                tab.session,
              );
              setTabs((prior) =>
                prior.map((t) =>
                  tabKey(t) === tabKey(tab)
                    ? { ...t, draft, imported: undefined }
                    : t,
                ),
              );
              const main = fileViews(vault, {
                ...vault.entry(tab.id),
                mime: tab.draft.mime,
                contentType: tab.draft.contentType,
              }).find(
                (view) =>
                  view.id === "tasks.editor" ||
                  view.id === "core.markdown.editor" ||
                  view.id === "core.csdb.editor",
              );
              if (main) void switchView(tab, main);
            }}
            recovered={async (id) => {
              await openFile(
                vault,
                vault.list().find((f) => f.id === id)!,
              );
            }}
          />
        </Suspense>
      ) : (
        <p className="p-4 text-muted-foreground">
          History is disabled for this file.
        </p>
      );
    if (part === "sharing")
      return (
        <div className="p-4">
          <VaultSharing
            onOpen={(target) => openFeatureTarget(target, "sync")}
            runtime={runtime}
            vault={vault}
            file={vault.entry(tab.id).path}
          />
        </div>
      );
    if (part === "columns")
      return (
        <VaultCollectionEditor
          value={tab.draft.text}
          onChange={(value) => {
            tab.draft.text = value;
            runtime.editors.changed(tab.vault, tab.id, "edit", tab.session);
            pulse();
          }}
          tasks={tab.draft.contentType === "jocki.task-list"}
          part="columns"
          required={Object.keys(
            contentTypes.find((t) => t.id === tab.draft.contentType)?.tables?.[
              "public.tasks"
            ]?.required ?? {},
          )}
        />
      );
    return inspector(tab, part);
  };
  const workspaceContext: MenuContext = {
    kind: "workspace",
    ...runtime.workspace.features,
  };
  const workspaceMenu = (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="h-8 min-w-0 flex-1 justify-between px-2"
              aria-label="Choose workspace"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceIcon />
            <span className="truncate">{runtime.workspace.current.name}</span>
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {runtime.library.list().map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              disabled={workspace.id === runtime.workspace.current.id}
              onClick={() =>
                changeWorkspace(() => runtime.switchWorkspace(workspace.id))
              }
            >
              <WorkspaceIcon />
              {workspace.name}
            </DropdownMenuItem>
          ))}
          {onHome && (
            <DropdownMenuItem onClick={onHome}>
              Close workspace
            </DropdownMenuItem>
          )}
          <ContributionItems
            bindings={menuBindings}
            location="workspace/context"
            context={workspaceContext}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  const explorer = (
    <VaultExplorer
      vaults={vaults}
      types={runtime.installedContentTypes()}
      templates={designatedTemplates}
      typeFilter={typeFilter}
      onFilter={setTypeFilter}
      active={current ? fileKey(current) : active}
      onOpen={(vault, file) => {
        setMobileFiles(false);
        void execute(() => openFile(vault, file));
      }}
      actions={explorerActions}
      rename={inlineRename}
      onRename={(value) => void execute(() => commitInlineRename(value))}
      onCancelRename={() => setInlineRename(undefined)}
    >
      <ExtensionViews
        runtime={runtime}
        location="sidebar"
        revision={revision}
        report={(e) => setError(e)}
      />
    </VaultExplorer>
  );
  const vaultPolicyTable = (
    <VaultPolicyTable
      vaults={vaults}
      onHistory={(vault) =>
        void execute(() => openFeature(explorerContext(vault, ""), "history"))
      }
      onSharing={(vault) =>
        void execute(() => openFeature(explorerContext(vault, ""), "sync"))
      }
      onOpen={() => {
        setSettingsOpen(false);
      }}
      onRescan={(vault) => void execute(() => vault.reconcile())}
      onRecover={(vault) => recoverDeleted(vault)}
      onClose={(vault) =>
        void execute(async () => {
          if (tabs.some((t) => t.vault === vault.id && tabDirty(t)))
            throw Error(
              "Save or discard this vault's drafts before closing it",
            );
          await runtime.close(vault.id);
          setTabs((prior) => prior.filter((t) => t.vault !== vault.id));
          search.current.remove(vault.id);
        })
      }
    />
  );
  const pageTitle = (key: string) =>
    key === "app:templates"
      ? "Templates and named paths"
      : key === "app:workspace"
        ? "Workspace"
        : key === "app:search"
          ? "Search"
          : key === "app:csdb"
            ? "CSDB imports"
            : key === "app:graph"
              ? "Graph"
              : key === "app:sharing"
                ? "Sharing"
                : key === "app:plugins"
                  ? "Plugins"
                  : key === "app:shortcuts"
                    ? "Keyboard shortcuts"
                    : key === "app:logs"
                      ? "Local logs"
                      : (runtime.extensions
                          .installed()
                          .find((e) => "app:plugin:" + e.manifest.id === key)
                          ?.manifest.name ?? "Settings");
  const renderAppPage = (key: string): ReactNode => {
    if (key === "app:csdb")
      return (
        <SettingsPage title="CSDB imports">
          <CSDBSettings runtime={runtime} changed={pulse} />
        </SettingsPage>
      );
    if (key === "app:templates")
      return (
        <SettingsPage title="Templates and named paths">
          <VaultTemplateSettings runtime={runtime} changed={pulse} />
        </SettingsPage>
      );
    if (key === "app:search")
      return (
        <VaultSearchPane
          query={query}
          onQuery={setQuery}
          hits={hits}
          vaultName={(id) => runtime.vaults.get(id)?.name ?? "Vault"}
          onOpen={(file) => {
            const vault = runtime.vaults.get(file.vault);
            const entry = vault?.list().find((entry) => entry.id === file.id);
            if (vault && entry) void execute(() => openFile(vault, entry));
          }}
        />
      );

    if (key === "app:graph")
      return (
        <section className="vault-graph">
          <div className="vault-toolbar">
            <label>
              <CheckboxInput
                type="checkbox"
                checked={graphLinks}
                onChange={(event) => setGraphLinks(event.target.checked)}
              />{" "}
              Links
            </label>
            <label>
              <CheckboxInput
                type="checkbox"
                checked={graphMetadata}
                onChange={(event) => setGraphMetadata(event.target.checked)}
              />{" "}
              Metadata
            </label>
            <label>
              <CheckboxInput
                type="checkbox"
                checked={graphHierarchy}
                onChange={(event) => setGraphHierarchy(event.target.checked)}
              />{" "}
              Folder hierarchy
            </label>
            <label>
              <CheckboxInput
                type="checkbox"
                checked={graphLocal}
                onChange={(e) => setGraphLocal(e.target.checked)}
              />{" "}
              Local graph
            </label>
            <label>
              Depth
              <Input
                type="number"
                min={1}
                max={20}
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
              />
            </label>
            <Input
              aria-label="Graph path or metadata filter"
              placeholder="Filter paths or metadata"
              value={graphFilter}
              onChange={(e) => setGraphFilter(e.target.value)}
            />
          </div>
          <ReactFlow
            nodes={graphNodes}
            edges={graphEdges}
            onNodeDoubleClick={(_, node) => {
              const f = files.find((f) => tabKey(f) === node.id)!;
              void execute(() => openFile(runtime.vaults.get(f.vault)!, f));
            }}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </section>
      );
    if (key === "app:plugins")
      return (
        <SettingsPage title="Plugins">
          <FilePluginSettings
            heading={false}
            runtime={runtime}
            changed={pulse}
            target={settingsTarget}
            onSettings={(id) => openAppPage("plugin:" + id)}
          />
        </SettingsPage>
      );
    if (key === "app:sharing")
      return (
        <SharingSettings
          runtime={runtime}
          onOpen={(target) => openFeatureTarget(target, "sync")}
        />
      );
    if (key === "app:logs") return <LogsPage runtime={runtime} />;
    if (key === "app:shortcuts")
      return (
        <SettingsPage title="Keyboard shortcuts">
          {" "}
          {commands.map((c) => (
            <label className="vault-hotkey" key={c.id}>
              {c.label}
              <Input
                defaultValue={settings.hotkeys[c.id] ?? c.shortcut}
                onBlur={(e) =>
                  void execute(() =>
                    runtime.workspace.update((d) => {
                      d.defaults.hotkeys[c.id] = e.target.value;
                    }),
                  )
                }
              />
            </label>
          ))}
        </SettingsPage>
      );
    if (key.startsWith("app:plugin:"))
      return (
        <PluginSettingsPage
          runtime={runtime}
          plugin={key.slice(11)}
          target={settingsTarget}
          changed={pulse}
          onTarget={setSettingsTarget}
        />
      );
    return (
      <SettingsPage
        title="Workspace"
        description="One active workspace, with references to any number of vaults."
      >
        <label className="block space-y-2">
          Workspace name
          <Input
            aria-label="Workspace name"
            key={runtime.workspace.current.name}
            defaultValue={runtime.workspace.current.name}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== runtime.workspace.current.name)
                void execute(async () => {
                  await runtime.workspace.update((d) => {
                    d.name = name;
                  });
                  await runtime.library.rememberCurrent();
                });
            }}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => coreActions["core.new-workspace"]({})}
          >
            <WorkspaceIcon />
            New workspace
          </Button>
        </div>
        <VaultFeatureButtons
          features={runtime.workspace.features}
          onHistory={() =>
            void execute(() => openFeature(workspaceContext, "history"))
          }
          onSharing={() =>
            void execute(() => openFeature(workspaceContext, "sync"))
          }
        />
        <section className="vault-page">
          <h2 className="font-semibold">Vaults</h2>
          <p>
            Open multiple folders in one workspace. Each vault keeps its own
            files, history, and search index.
          </p>
          <div className="vault-toolbar">
            <Button
              variant="outline"
              className="primary"
              onClick={() => void execute(() => runtime.add())}
            >
              Open folder
            </Button>
            {!window.jockiVaults && (
              <Button
                variant="outline"
                onClick={() => {
                  let name = "Vault";
                  setModal({
                    title: "Create browser vault",
                    body: (
                      <label>
                        Name
                        <Input
                          defaultValue={name}
                          onChange={(e) => {
                            name = e.target.value;
                          }}
                        />
                      </label>
                    ),
                    actions: (
                      <Button
                        variant="outline"
                        onClick={() =>
                          void execute(async () => {
                            await runtime.add(name);
                            setModal(undefined);
                          })
                        }
                      >
                        Create
                      </Button>
                    ),
                  });
                }}
              >
                Create browser vault
              </Button>
            )}
          </div>
          {vaultPolicyTable}

          {!vaults.length && (
            <p>Choose a folder to start, or create a private browser vault.</p>
          )}
        </section>
        {knownVaults.some((v) => !runtime.vaults.has(v.id)) && (
          <section className="space-y-2">
            <h2 className="font-medium">Vaults from other workspaces</h2>
            {knownVaults
              .filter((v) => !runtime.vaults.has(v.id))
              .map((v) => (
                <Button
                  key={v.id}
                  variant="outline"
                  onClick={() =>
                    void execute(() =>
                      runtime.mountKnownVault(v.id, v.location),
                    )
                  }
                >
                  Open vault from {v.workspace} · {v.id.slice(0, 8)}
                </Button>
              ))}
          </section>
        )}
        <label className="flex items-center gap-2">
          <CheckboxInput
            type="checkbox"
            checked={settings.vim}
            onChange={(e) =>
              void execute(() =>
                runtime.workspace.update((d) => {
                  d.computers[runtime.computer].vim = e.target.checked;
                }),
              )
            }
          />
          Vim keybindings
        </label>
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" />}>
            Advanced workspace settings
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            {" "}
            <label>
              Edit settings for{" "}
              <LegacySelect
                value={settingsTarget}
                onChange={(e) => setSettingsTarget(e.target.value)}
              >
                <option value="defaults">Defaults</option>
                {Object.keys(runtime.workspace.current.computers).map((id) => (
                  <option key={id} value={id}>
                    {id}
                    {id === runtime.computer ? " (this computer)" : ""}
                  </option>
                ))}
              </LegacySelect>
            </label>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void execute(async () => {
                  const value = JSON.parse(settingsJSON) as
                    WorkspaceDefaults | ComputerOverrides;
                  await runtime.workspace.update((d) => {
                    if (settingsTarget === "defaults")
                      d.defaults = value as WorkspaceDefaults;
                    else
                      d.computers[settingsTarget] = value as ComputerOverrides;
                  });
                });
              }}
            >
              <Textarea
                aria-label="Workspace settings JSON"
                className="vault-settings-json"
                value={settingsJSON}
                onChange={(e) => setSettingsJSON(e.target.value)}
              />
              <Button variant="outline" className="primary" type="submit">
                Save settings
              </Button>
            </form>
          </CollapsibleContent>
        </Collapsible>
      </SettingsPage>
    );
  };
  const toolbarContext = current
    ? explorerContext(
        runtime.vaults.get(current.vault)!,
        runtime.vaults.get(current.vault)!.entry(current.id).path,
        { id: current.id },
      )
    : workspaceContext;
  const navigationPane = (
    <VaultNavigation
      host={runtime.extensions}
      selected={navigation}
      onSelect={setNavigation}
      footer={workspaceMenu}
    >
      {navigation === "core.navigation.files" ? (
        explorer
      ) : navigation === "core.navigation.search" ? (
        renderAppPage("app:search")
      ) : navigation === "core.navigation.graph" ? (
        renderAppPage("app:graph")
      ) : (
        <ExtensionViews
          runtime={runtime}
          location="navigation"
          selected={navigation}
          revision={revision}
          report={setError}
        />
      )}
    </VaultNavigation>
  );
  return (
    <main className="vault-app">
      <VaultTopbar
        onFiles={() => {
          if (window.matchMedia("(max-width:767px)").matches)
            setMobileFiles(true);
          else setFilesOpen(!filesOpen);
        }}
        onSettings={() => setSettingsOpen(true)}
        status={busy ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
      />
      <div className="vault-workspace">
        {filesOpen && (
          <aside className="hidden w-64 shrink-0 border-r bg-sidebar md:block">
            {navigationPane}
          </aside>
        )}
        <Sheet open={mobileFiles} onOpenChange={setMobileFiles}>
          <SheetContent side="left" className="p-0">
            <SheetHeader>
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Browse files and folders in open vaults.
              </SheetDescription>
            </SheetHeader>
            {navigationPane}
          </SheetContent>
        </Sheet>
        <div className="vault-main">
          <>
            <VaultDock
              ready={layoutReady}
              files={[
                ...appTabs.map((key) => ({
                  key,
                  name: pageTitle(key),
                  dirty: false,
                  pinned: false,
                  view: "page" as const,
                })),
                ...tabs
                  .filter((t) => !t.popout)
                  .map((t) => ({
                    key: tabKey(t),
                    name: runtime.vaults
                      .get(t.vault)!
                      .entry(t.id)
                      .path.split("/")
                      .pop()!,
                    dirty: tabDirty(t),
                    pinned: t.pinned,
                    view: t.view ?? "edit",
                  })),
              ]}
              active={active}
              onActive={setActive}
              layout={dockLayout}
              onLayout={(layout) => {
                setDockLayout(layout);
                void runtime.workspace
                  .update((d) => {
                    d.computers[runtime.computer].layout ??= {};
                    const settings = d.computers[runtime.computer].layout!;
                    settings.dock ??= {};
                    patchSettings(
                      settings.dock as Record<string, unknown>,
                      layout as unknown as Record<string, unknown>,
                    );
                  })
                  .catch((e) => setError(e));
              }}
              onPaneAPI={(api) => {
                paneAPI.current = api;
              }}
              viewPicker={(view) => {
                if (view.view === "page") return null;
                const tab = tabs.find((tab) => tabKey(tab) === view.file);
                if (!tab) return null;
                const vault = runtime.vaults.get(tab.vault)!,
                  file = {
                    ...vault.entry(tab.id),
                    mime: tab.draft.mime,
                    contentType: tab.draft.contentType,
                  };
                return (
                  <FileViewPicker
                    file={file.path.split("/").pop()!}
                    current={tab.editorId}
                    views={fileViews(vault, file)}
                    onChoose={(selected) =>
                      void execute(() => switchView(tab, selected))
                    }
                  />
                );
              }}
              title={(view) => {
                if (view.view === "page") return pageTitle(view.file);
                const tab = tabs.find((tab) => tabKey(tab) === view.file);
                return tab
                  ? runtime.vaults
                      .get(tab.vault)!
                      .entry(tab.id)
                      .path.split("/")
                      .pop()!
                  : "File";
              }}
              openExternal={async (view) => {
                const [vaultId, id] = view.file.split("/");
                const vault = runtime.vaults.get(vaultId),
                  file = vault?.list().find((f) => f.id === id);
                if (!vault || !file) return false;
                return new Promise<boolean>((resolve) => {
                  void openFile(vault, file, undefined, resolve).catch(
                    (error) => {
                      setError(error);
                      resolve(false);
                    },
                  );
                });
              }}
              closeFile={(key) => {
                if (key.startsWith("app:")) {
                  setAppTabs((prior) => prior.filter((p) => p !== key));
                  return;
                }
                const tab = tabs.find((t) => tabKey(t) === key);
                if (tab) close(tab);
              }}
              render={(view, focused) => {
                if (view.view === "page") return renderAppPage(view.file);
                const tab = tabs.find((t) => tabKey(t) === view.file);
                return tab ? renderPane(tab, view.view, focused) : null;
              }}
            />
            <ExtensionViews
              runtime={runtime}
              location="panel"
              revision={revision}
              report={(e) => setError(e)}
            />
          </>
        </div>
        <SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen}>
          <nav className="space-y-1 p-2" aria-label="Settings pages">
            {menuBindings
              .items("settings", workspaceContext)
              .map((item, index, items) => (
                <div key={item.id}>
                  {index > 0 && items[index - 1].group !== item.group && (
                    <div className="my-3 border-t" />
                  )}
                  <Button
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() => menuBindings.execute(item, workspaceContext)}
                  >
                    <ContributionIcon name={item.icon} />
                    {item.title}
                  </Button>
                </div>
              ))}
          </nav>
        </SettingsDrawer>
      </div>
      <VaultStatusBar
        host={runtime.extensions}
        execute={(command) =>
          void execute(() => runtime.extensions.executeCommand(command))
        }
      />
      {tabs
        .filter((t) => t.popout && !t.popout.closed)
        .map((t) =>
          createPortal(
            <div className="vault-app vault-popout">{editor(t, false)}</div>,
            t.popout!.document.body,
            tabKey(t),
          ),
        )}

      <VaultRequests runtime={runtime} />
      <Dialog
        open={Boolean(modal)}
        onOpenChange={(open) => {
          if (!open) {
            modal?.cancel?.();
            pendingClose.current?.(false);
            pendingClose.current = undefined;
            setModal(undefined);
          }
        }}
      >
        <DialogContent
          className={
            modal?.wide
              ? featureDialogClass
              : "max-h-[85dvh] overflow-y-auto sm:max-w-3xl"
          }
        >
          <DialogHeader className="shrink-0">
            <div className="flex items-center gap-1">
              <DialogTitle>{modal?.title}</DialogTitle>
              {modal?.feature && <FeatureInfo feature={modal.feature} />}
            </div>
            <DialogDescription className="sr-only">
              {modal?.title}
            </DialogDescription>
          </DialogHeader>

          {modal?.wide ? (
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              data-history-body
            >
              {modal.body}
            </div>
          ) : (
            modal?.body
          )}
          {modal?.actions && (
            <div className="flex shrink-0 justify-end gap-2">
              {modal.actions}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function Properties({
  value,
  change,
}: {
  value: string;
  change(value: string): void;
}) {
  const meta = noteMetadata(value),
    [error, setError] = useReportedError("vault-app");
  return (
    <div className="vault-form">
      {Object.entries(meta.properties).map(([key, property]) => (
        <label key={key}>
          {key}
          <Input
            key={JSON.stringify(property)}
            defaultValue={
              typeof property === "string" ? property : JSON.stringify(property)
            }
            onBlur={(e) => {
              try {
                let next: unknown;
                try {
                  next = JSON.parse(e.target.value);
                } catch {
                  next = e.target.value;
                }
                change(
                  withProperties(value, { ...meta.properties, [key]: next }),
                );
                setError("");
              } catch (error) {
                setError(error);
              }
            }}
          />
        </label>
      ))}
      <Button
        variant="outline"
        onClick={() => {
          const name = "property" + (Object.keys(meta.properties).length + 1);
          change(withProperties(value, { ...meta.properties, [name]: "" }));
        }}
      >
        Add property
      </Button>
    </div>
  );
}
