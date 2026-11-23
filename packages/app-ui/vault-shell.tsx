import { effectiveFeatures } from "../core/vaults/scope-policy";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../ui/primitives/tabs";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Search,
  Network,
  Library,
  Save,
  X,
  FilePlus2,
  Upload,
  FolderPlus,
  Pencil,
  Trash2,
  Share2,
  History,
  FileText,
  Copy,
  Link2,
  BookTemplate,
} from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Switch } from "../ui/primitives/switch";
import { Input } from "../ui/primitives/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../ui/primitives/sheet";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/primitives/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "../ui/primitives/dropdown-menu";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/primitives/collapsible";
import {
  ContributionMenu,
  ContributionContextMenu,
  type MenuBindings,
} from "./contribution-menu";
import type { MenuContext } from "../platform/src/file-sdk/ui-registry";
import { ChoiceSelect } from "../ui/choice-select";
import type { FileSummary, ContentType } from "../core/vaults/contracts";
import type { FileVault } from "../core/vaults/vault";
import {
  type DockTab,
  type DockLayout,
  type DockView,
  dockKey,
  dockTab,
  dropZone,
  dropRect,
  validDock,
} from "../ui/dock-model";

/** Application adapter for the shared shadcn switch. */
export function CheckboxInput({
  checked,
  defaultChecked,
  onChange,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Switch
      aria-label={props["aria-label"]}
      checked={checked}
      defaultChecked={defaultChecked}
      disabled={props.disabled}
      onCheckedChange={(checked) =>
        onChange?.({
          target: { checked },
          currentTarget: { checked },
        } as React.ChangeEvent<HTMLInputElement>)
      }
    />
  );
}
export function IconButton({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string;
  children?: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </Button>
  );
}
export function VaultTopbar({
  onFiles,
  onSettings,
  status,
}: {
  onFiles(): void;
  onSettings(): void;
  status?: string;
}) {
  return (
    <header
      className="flex h-9 shrink-0 items-center justify-between border-b px-2"
      data-vault-topbar
    >
      <IconButton label="Toggle navigation pane" onClick={onFiles}>
        <PanelLeft />
      </IconButton>
      <span className="sr-only" role="status">
        {status}
      </span>
      <IconButton label="Settings" onClick={onSettings}>
        <PanelRight />
      </IconButton>
    </header>
  );
}
export function SettingsDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  return open ? (
    <aside
      data-settings-pane
      aria-label="Settings navigation"
      className="w-64 max-w-[45vw] min-w-0 shrink-0 overflow-auto border-l bg-background"
    >
      <div className="flex h-10 items-center justify-between border-b px-3">
        <strong className="text-sm">Settings</strong>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close settings pane"
          onClick={() => onOpenChange(false)}
        >
          ×
        </Button>
      </div>
      {children}
    </aside>
  ) : null;
}
export function MobileTools({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const finish = (event: Event) => {
      if ((event as CustomEvent).detail?.phase === "drop") setOpen(false);
    };
    window.addEventListener("jocki-pane-pointer", finish);
    return () => window.removeEventListener("jocki-pane-pointer", finish);
  }, []);
  return (
    <div className="md:hidden">
      <Button
        className="w-full rounded-none border-t"
        variant="ghost"
        aria-label="Document tools"
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal />
        <span className="sr-only">Document tools</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[65dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Document tools</SheetTitle>
            <SheetDescription>
              Open a view, or drag its icon into a pane.
            </SheetDescription>
          </SheetHeader>
          <div
            className="overflow-x-auto px-4 pb-6"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("[data-document-view]"))
                setOpen(false);
            }}
          >
            {children}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
export interface VaultTemplate {
  id: string;
  name: string;
  plugin?: string;
  vault?: string;
  file?: string;
  text?: string;
  extension: string;
  contentType?: string | null;
  enabled?: boolean;
}
export interface ExplorerActions {
  menu: MenuBindings;
  newFile(vault: FileVault, folder: string, type: string): void;
  newFolder(vault: FileVault, folder: string): void;
  template(
    vault: FileVault,
    folder: string,
    template: VaultTemplate,
    mode: "copy" | "reference",
  ): void;
  rename(vault: FileVault, path: string, file?: FileSummary): void;
  remove(vault: FileVault, path: string, file?: FileSummary): void;
  designate?(vault: FileVault, file: FileSummary): void;
  extra?(vault: FileVault, file: FileSummary): ReactNode;
}
export function explorerContext(
  vault: FileVault,
  path: string,
  file?: { id: string },
): MenuContext {
  return {
    kind: file ? "file" : path ? "folder" : "vault",
    vault: vault.id,
    path,
    ...(file
      ? {
          id: file.id,
          mime: vault.fileMime(file.id),
          contentType: vault.contentType(file.id),
          history: vault.features(file.id).history,
        }
      : {
          history: effectiveFeatures(
            vault.scopePolicies,
            vault.workspaceFeatures,
            path ? path + "/.scope" : "",
          ).history,
        }),
    sync: file
      ? vault.syncEnabled(file.id)
      : effectiveFeatures(
          vault.scopePolicies,
          vault.workspaceFeatures,
          path ? path + "/.scope" : "",
        ).sync,
  };
}
export function ExplorerMenu({
  vault,
  path,
  file,
  actions,
  trigger,
}: {
  vault: FileVault;
  path: string;
  file?: Pick<FileSummary, "id">;
  actions: ExplorerActions;
  types?: ContentType[];
  templates?: VaultTemplate[];
  trigger?: React.ReactElement;
}) {
  return (
    <ContributionMenu
      bindings={actions.menu}
      location="explorer/context"
      context={explorerContext(vault, path, file)}
      trigger={trigger}
      label={`Actions for ${path || vault.name}`}
    />
  );
}
export function VaultExplorer({
  vaults,
  types,
  templates,
  typeFilter,
  onFilter,
  active,
  onOpen,
  actions,
  rename,
  onRename,
  onCancelRename,
  children,
}: {
  vaults: FileVault[];
  types: ContentType[];
  templates: VaultTemplate[];
  typeFilter: string;
  onFilter(value: string): void;
  active?: string;
  onOpen(vault: FileVault, file: FileSummary): void;
  actions: ExplorerActions;
  rename?: { vault: string; path: string; folder: boolean; fresh?: boolean };
  onRename(value: string): void;
  onCancelRename(): void;
  children?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const toggle = (key: string, open: boolean) =>
    setCollapsed((prior) => {
      const next = new Set(prior);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  useEffect(() => {
    const target = rename
      ? { vault: rename.vault, path: rename.path }
      : vaults
          .flatMap((v) =>
            v.list().map((f) => ({
              vault: v.id,
              path: f.path,
              key: v.id + "/" + f.id,
            })),
          )
          .find((f) => f.key === active);
    if (!target) return;
    setCollapsed((prior) => {
      const next = new Set(
        [...prior].filter(
          (key) =>
            key !== target.vault &&
            !(
              key.startsWith(target.vault + "/") &&
              target.path.startsWith(key.slice(target.vault.length + 1) + "/")
            ),
        ),
      );
      return next.size === prior.size ? prior : next;
    });
  }, [active, rename?.vault, rename?.path]);
  const inventories = new Map(vaults.map((vault) => [vault.id, vault.list()]));
  const render = (vault: FileVault, prefix = ""): ReactNode => {
    const all = inventories.get(vault.id)!,
      shown = all.filter(
        (f) =>
          !typeFilter ||
          (typeFilter === "untyped"
            ? !f.contentType
            : f.contentType === typeFilter),
      );
    const folders = vault
      .directories()
      .filter(
        (path) =>
          !typeFilter || shown.some((f) => f.path.startsWith(path + "/")),
      );
    const names = [
      ...new Set(
        [...shown.map((f) => f.path), ...folders]
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length).split("/")[0]),
      ),
    ].sort(
      (a, b) =>
        Number(!folders.includes(prefix + a)) -
          Number(!folders.includes(prefix + b)) || a.localeCompare(b),
    );
    return names.map((name) => {
      const path = prefix + name,
        file = shown.find((f) => f.path === path),
        folder = !file;
      const editing = rename?.vault === vault.id && rename.path === path;
      const label = editing ? (
        <Input
          key={path}
          aria-label={folder ? "Folder name" : "File name"}
          defaultValue={name}
          autoFocus
          onFocus={(event) => {
            const end = folder ? name.length : name.lastIndexOf(".");
            event.target.setSelectionRange(0, end > 0 ? end : name.length);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onRename(event.currentTarget.value);
            }
            if (event.key === "Escape") onCancelRename();
          }}
          onBlur={(event) => onRename(event.target.value)}
          className="h-6 min-w-0 flex-1"
        />
      ) : (
        <span className="truncate">{name}</span>
      );
      const menu = (
        <ExplorerMenu
          vault={vault}
          path={path}
          file={file}
          types={types}
          templates={templates}
          actions={actions}
        />
      );
      if (file)
        return (
          <ContributionContextMenu
            key={path}
            bindings={actions.menu}
            context={explorerContext(vault, path, file)}
          >
            <div
              className={`group flex min-w-0 items-center rounded-md hover:bg-accent ${active === vault.id + "/" + file.id ? "bg-accent text-accent-foreground" : ""}`}
              data-explorer-path={path}
              draggable={!editing}
              onDragStart={(event) =>
                startPaneDrag(event, {
                  file: vault.id + "/" + file.id,
                  view: "edit",
                })
              }
            >
              {editing ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
                  <File className="size-4 shrink-0" />
                  {label}
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="h-7 min-w-0 flex-1 justify-start gap-2 px-2 font-normal hover:bg-transparent"
                  onClick={() => onOpen(vault, file)}
                >
                  <File className="shrink-0" />
                  {label}
                </Button>
              )}
              {file.metadataError && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-destructive"
                  aria-label={`Metadata error for ${name}`}
                  title={file.metadataError + " — click to clear and recheck"}
                  onClick={() => void vault.recheckMetadata(file.id)}
                >
                  !
                </Button>
              )}
              {menu}
            </div>
          </ContributionContextMenu>
        );
      return (
        <Collapsible
          key={path}
          open={!collapsed.has(vault.id + "/" + path)}
          onOpenChange={(open) => toggle(vault.id + "/" + path, open)}
        >
          <ContributionContextMenu
            bindings={actions.menu}
            context={explorerContext(vault, path)}
          >
            <div
              className="flex min-w-0 items-center rounded-md hover:bg-accent"
              data-explorer-path={path}
            >
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    className="group h-7 min-w-0 flex-1 justify-start gap-2 px-2 font-normal hover:bg-transparent"
                  />
                }
              >
                <ChevronRight className="transition-transform group-aria-expanded:rotate-90" />
                <Folder />
                {!editing && label}
              </CollapsibleTrigger>
              {editing && label}
              {menu}
            </div>
          </ContributionContextMenu>
          <CollapsibleContent className="ml-3 border-l pl-1">
            {render(vault, path + "/")}
          </CollapsibleContent>
        </Collapsible>
      );
    });
  };
  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="File browser">
      <div className="p-2">
        <ChoiceSelect
          placeholder="All content types"
          aria-label="Filter content type"
          value={typeFilter}
          onValueChange={onFilter}
          options={[
            { value: "", label: "All content types" },
            { value: "untyped", label: "Unspecified" },
            ...types.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      </div>
      <div className="flex-1 overflow-auto px-2">
        {vaults.map((vault) => (
          <Collapsible
            key={vault.id}
            open={!collapsed.has(vault.id)}
            onOpenChange={(open) => toggle(vault.id, open)}
            className="mb-1"
          >
            <ContributionContextMenu
              bindings={actions.menu}
              context={explorerContext(vault, "")}
            >
              <div className="flex items-center rounded-md hover:bg-accent">
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      className="group h-7 min-w-0 flex-1 justify-start gap-2 px-2 hover:bg-transparent"
                    />
                  }
                >
                  <ChevronRight className="transition-transform group-aria-expanded:rotate-90" />
                  <FolderOpen />
                  <span className="truncate">{vault.name}</span>
                </CollapsibleTrigger>
                <ExplorerMenu
                  vault={vault}
                  path=""
                  types={types}
                  templates={templates}
                  actions={actions}
                />
              </div>
            </ContributionContextMenu>
            <CollapsibleContent className="ml-3 border-l pl-1">
              {render(vault)}
            </CollapsibleContent>
          </Collapsible>
        ))}
        {children}
      </div>
    </div>
  );
}
export const dockMime = "application/x-jocki-pane";
/** Pointer fallback keeps pane dragging available on touchscreens. */
export function startPanePointer(event: React.PointerEvent, tab: DockTab) {
  if (event.pointerType === "mouse") return;
  const start = { x: event.clientX, y: event.clientY };
  let moved = false;
  const send = (phase: string, e: PointerEvent) =>
    window.dispatchEvent(
      new CustomEvent("jocki-pane-pointer", {
        detail: { phase, tab, x: e.clientX, y: e.clientY },
      }),
    );
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) moved = true;
    if (moved) {
      e.preventDefault();
      send("move", e);
    }
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    if (moved) send("drop", e);
  };
  const cancel = (e: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    send("cancel", e);
  };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", cancel);
}
export function startPaneDrag(event: React.DragEvent, tab: DockTab) {
  event.dataTransfer.setData(dockMime, JSON.stringify(tab));
  event.dataTransfer.effectAllowed = "move";
  window.dispatchEvent(new Event("jocki-pane-start"));
}
export function VaultDock({
  files,
  active,
  onActive,
  layout,
  onLayout,
  render,
  title,
  closeFile,
  onPaneAPI,
  openExternal,
  ready = true,
  viewPicker,
}: {
  ready?: boolean;
  viewPicker?(tab: DockTab): ReactNode;
  files: {
    key: string;
    name: string;
    dirty: boolean;
    pinned: boolean;
    view?: DockView;
  }[];
  active: string;
  onActive(file: string): void;
  layout?: unknown;
  onLayout(value: DockLayout): void;
  render(tab: DockTab, focused: boolean): ReactNode;
  title(tab: DockTab): string;
  closeFile(file: string): void;
  openExternal?(tab: DockTab): Promise<boolean>;
  onPaneAPI?(api: {
    open(tab: DockTab): void;
    split(tab: DockTab): void;
    replace(from: DockTab, to: DockTab): void;
  }): void;
}) {
  const opened = useRef(new Set<string>());
  const [dragging, setDragging] = useState(false);
  const [model, setModel] = useState<DockLayout>(() =>
      validDock(layout) ? layout : { panes: [] },
    ),
    [zone, setZone] = useState<readonly number[]>(),
    root = useRef<HTMLDivElement>(null),
    latest = useRef(model);
  latest.current = model;
  const commit = (next: DockLayout) => {
    latest.current = next;
    setModel(next);
    onLayout(next);
  };
  useEffect(() => {
    if (!ready) return;
    let next = structuredClone(latest.current),
      changed = false;
    for (const pane of next.panes) {
      const activeIndex = Math.max(
        0,
        pane.tabs.findIndex((t) => dockKey(t) === pane.active),
      );
      const tabs = pane.tabs.filter((t) => files.some((f) => f.key === t.file));
      if (tabs.length !== pane.tabs.length) {
        pane.tabs = tabs;
        changed = true;
      }
      if (!tabs.some((t) => dockKey(t) === pane.active))
        pane.active = tabs.length
          ? dockKey(tabs[Math.min(activeIndex, tabs.length - 1)])
          : "";
    }
    next.panes = next.panes.filter((p) => p.tabs.length);
    for (const f of files)
      if (
        !next.panes.some((p) =>
          p.tabs.some((t) => t.file === f.key && t.view === (f.view ?? "edit")),
        )
      ) {
        next = dockTab(next, { file: f.key, view: f.view ?? "edit" }, [1, 1]);
        changed = true;
      }
    if (!next.panes.some((p) => p.id === next.activePane)) {
      if (next.panes.length) next.activePane = next.panes[0].id;
      else delete next.activePane;
    }
    if (changed) commit(next);
    if (!files.some((f) => f.key === active)) {
      const pane =
          next.panes.find((p) => p.id === next.activePane) ?? next.panes[0],
        tab = pane?.tabs.find((t) => dockKey(t) === pane.active);
      if (tab) onActive(tab.file);
    }
  }, [ready, files.map((f) => f.key).join()]);
  useEffect(() => {
    onPaneAPI?.({
      split: (tab) => commit(dockTab(latest.current, tab, [2, 1])),
      replace: (from, to) => {
        const next = structuredClone(latest.current);
        for (const pane of next.panes) {
          const index = pane.tabs.findIndex(
            (tab) => dockKey(tab) === dockKey(from),
          );
          if (index < 0) continue;
          pane.tabs[index] = to;
          if (pane.active === dockKey(from)) pane.active = dockKey(to);
        }
        commit(next);
      },
      open: (tab) => {
        const next = structuredClone(latest.current),
          existing = next.panes.find((p) =>
            p.tabs.some((t) => dockKey(t) === dockKey(tab)),
          );
        if (existing) {
          existing.active = dockKey(tab);
          next.activePane = existing.id;
          commit(next);
          return;
        }
        const target =
          next.panes.find((p) => p.id === next.activePane)?.id ??
          next.panes[0]?.id;
        commit(dockTab(next, tab, [1, 1], target));
      },
    });
  }, [active]);
  useEffect(() => {
    const pointer = async (event: Event) => {
      const { phase, tab, x, y } = (event as CustomEvent).detail,
        rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      const inside =
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (phase === "cancel" || !inside) {
        setZone(undefined);
        return;
      }
      const nextZone = dropZone(
        (x - rect.left) / rect.width,
        (y - rect.top) / rect.height,
      );
      if (phase === "move") setZone(nextZone);
      if (phase === "drop") {
        if (
          !files.some((f) => f.key === tab.file) &&
          !(await openExternal?.(tab))
        )
          return;
        commit(dockTab(latest.current, tab, nextZone));
        onActive(tab.file);
        setZone(undefined);
      }
    };
    window.addEventListener("jocki-pane-pointer", pointer);
    return () => window.removeEventListener("jocki-pane-pointer", pointer);
  }, [files.map((f) => f.key).join()]);
  useEffect(() => {
    const start = () => setDragging(true),
      end = () => {
        setDragging(false);
        setZone(undefined);
      };
    window.addEventListener("jocki-pane-start", start);
    window.addEventListener("dragend", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("jocki-pane-start", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  return (
    <div
      ref={root}
      className="vault-dock"
      data-pane-dragging={dragging}
      data-dock-wrapper
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(dockMime)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setZone(
          dropZone(
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
          ),
        );
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setZone(undefined);
      }}
      onDrop={async (event) => {
        event.preventDefault();
        try {
          const tab = JSON.parse(
            event.dataTransfer.getData(dockMime),
          ) as DockTab;
          const rect = event.currentTarget.getBoundingClientRect();
          const zone = dropZone(
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
          );
          if (
            !files.some((f) => f.key === tab.file) &&
            !(await openExternal?.(tab))
          )
            return;
          commit(dockTab(latest.current, tab, zone));
          onActive(tab.file);
        } finally {
          setZone(undefined);
        }
      }}
    >
      {!model.panes.length && (
        <div className="col-span-2 row-span-2 grid place-items-center text-muted-foreground">
          Open a file from a vault.
        </div>
      )}
      {[0, 1].flatMap((y) =>
        [0, 1].map((x) =>
          !model.panes.some(
            (p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h,
          ) && model.panes.length ? (
            <div
              key={x + ":" + y}
              className="vault-dock-empty grid place-items-center bg-muted/20 text-xs text-muted-foreground"
              style={{ gridColumn: x + 1, gridRow: y + 1 }}
            >
              Drop a view here
            </div>
          ) : null,
        ),
      )}
      {model.panes.map((pane) => (
        <Tabs
          key={pane.id}
          value={pane.active}
          onValueChange={(value) => {
            const next = structuredClone(latest.current),
              p = next.panes.find((p) => p.id === pane.id)!;
            p.active = String(value);
            next.activePane = pane.id;
            commit(next);
            const tab = p.tabs.find((t) => dockKey(t) === String(value));
            if (tab) onActive(tab.file);
          }}
          className="vault-dock-pane gap-0"
          style={{
            gridColumn: `${pane.x + 1} / span ${pane.w}`,
            gridRow: `${pane.y + 1} / span ${pane.h}`,
          }}
          data-dock-pane={pane.id}
          data-dock-focused={
            (model.activePane ?? model.panes[0]?.id) === pane.id
          }
          onPointerDown={() => {
            if (latest.current.activePane !== pane.id) {
              commit({ ...latest.current, activePane: pane.id });
              const tab = pane.tabs.find((t) => dockKey(t) === pane.active);
              if (tab) onActive(tab.file);
            }
          }}
        >
          <div className="shrink-0 overflow-x-auto border-b">
            <TabsList
              className="h-9 min-w-full justify-start rounded-none p-0"
              aria-label="Pane tabs"
            >
              {pane.tabs.map((tab, index) => {
                const f = files.find((f) => f.key === tab.file);
                return (
                  <div
                    key={dockKey(tab)}
                    className={`flex h-full shrink-0 items-center gap-1 p-1 ${pane.active === dockKey(tab) ? "bg-background text-foreground" : "bg-muted text-muted-foreground"}`}
                    data-dock-tab={dockKey(tab)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onDrop={async (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      try {
                        const item = JSON.parse(
                          event.dataTransfer.getData(dockMime),
                        ) as DockTab;
                        if (
                          !files.some((f) => f.key === item.file) &&
                          !(await openExternal?.(item))
                        )
                          return;
                        commit(
                          dockTab(latest.current, item, [1, 1], pane.id, index),
                        );
                      } finally {
                        setZone(undefined);
                      }
                    }}
                  >
                    {viewPicker?.(tab)}
                    <TabsTrigger
                      value={dockKey(tab)}
                      className="h-full shrink-0 touch-none justify-start rounded-none border-0 bg-transparent px-0 shadow-none data-active:bg-transparent data-active:shadow-none dark:data-active:bg-transparent"
                      draggable
                      onDragStart={(event) => startPaneDrag(event, tab)}
                      onPointerDown={(event) => startPanePointer(event, tab)}
                      onClick={() => onActive(tab.file)}
                    >
                      {title(tab)}
                      {tab.view !== "page" && f?.dirty ? " •" : ""}
                      {f?.pinned ? " ·" : ""}
                    </TabsTrigger>
                    <IconButton
                      size="icon-xs"
                      label={`Close ${title(tab)}`}
                      onClick={() => {
                        if (
                          latest.current.panes
                            .flatMap((p) => p.tabs)
                            .filter((t) => t.file === tab.file).length === 1
                        ) {
                          closeFile(tab.file);
                          return;
                        }
                        const next = structuredClone(latest.current),
                          p = next.panes.find((p) => p.id === pane.id)!;
                        p.tabs = p.tabs.filter(
                          (t) => dockKey(t) !== dockKey(tab),
                        );
                        p.active = p.tabs.length
                          ? dockKey(p.tabs[Math.min(index, p.tabs.length - 1)])
                          : "";
                        next.panes = next.panes.filter((p) => p.tabs.length);
                        if (!next.panes.some((p) => p.id === next.activePane)) {
                          if (next.panes.length)
                            next.activePane = next.panes[0].id;
                          else delete next.activePane;
                        }
                        if (next.panes.length === 1)
                          Object.assign(next.panes[0], {
                            x: 0,
                            y: 0,
                            w: 2,
                            h: 2,
                          });
                        commit(next);
                      }}
                    >
                      <X />
                    </IconButton>
                  </div>
                );
              })}
            </TabsList>
          </div>
          {pane.tabs.map((tab) => {
            const key = dockKey(tab);
            if (key === pane.active) opened.current.add(key);
            return (
              <TabsContent
                key={key}
                value={key}
                keepMounted
                className="min-h-0 flex-1 overflow-auto"
              >
                {opened.current.has(key)
                  ? render(
                      tab,
                      key === pane.active &&
                        (model.activePane ?? model.panes[0]?.id) === pane.id,
                    )
                  : null}
              </TabsContent>
            );
          })}
        </Tabs>
      ))}
      {zone && (
        <div className="pointer-events-none absolute inset-0 z-30 grid grid-cols-2 grid-rows-2">
          <div
            className="rounded-lg border-2 border-primary bg-primary/15"
            style={{
              gridColumn: `${dropRect(zone).x + 1} / span ${dropRect(zone).w}`,
              gridRow: `${dropRect(zone).y + 1} / span ${dropRect(zone).h}`,
            }}
          />
        </div>
      )}
    </div>
  );
}
