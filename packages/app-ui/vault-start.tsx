import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { ChoiceSelect } from "../ui/choice-select";
import { notify } from "../ui/notifications";
import type {
  VaultLauncher,
  WorkspaceCreation,
  LauncherJoin,
  VaultSelection,
} from "../platform-browser/vault-runtime";
import type {
  ShareDocument,
  ShareInvitation,
} from "../core/vaults/protected-sync";
import { parseShareLink } from "../core/vaults/share-invitation";
import { StartScreen } from "./start-screen";
import { WorkspaceManage } from "./vault-workspace-manage";
import {
  StorageChoice,
  WorkspaceDestinationFields,
  VaultDestinationFields,
  emptyWorkspace,
  validWorkspace,
  validVault,
} from "./vault-start-forms";

export type WorkspaceDestination = {
  id?: string;
  name?: string;
  create?: WorkspaceCreation;
  invitation?: LauncherJoin;
};
/** Browsing the start screen never opens a workspace. */
export function VaultStart({
  launcher,
  error: externalError,
  onOpen,
}: {
  launcher: VaultLauncher;
  error: string;
  onOpen(destination: WorkspaceDestination): Promise<void>;
}) {
  const [page, setPage] = useState<"create" | "join" | "manage">(),
    [workspace, setWorkspace] = useState(emptyWorkspace),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState(""),
    [preview, setPreview] = useState<ShareInvitation>(),
    [inspected, setInspected] = useState<ShareDocument>(),
    [vault, setVault] = useState<VaultSelection>({
      kind: "internal",
      name: "",
    }),
    [children, setChildren] = useState<Record<string, VaultSelection>>({}),
    [mode, setMode] = useState<"new" | "existing">("new"),
    [existing, setExisting] = useState(""),
    [references, setReferences] = useState<
      Awaited<ReturnType<VaultLauncher["references"]>>
    >([]);
  useEffect(() => {
    if (externalError) {
      setPage(undefined);
      notify.error(externalError);
    }
  }, [externalError]);
  useEffect(() => {
    if (page !== "join") return;
    let active = true;
    void launcher
      .references()
      .then((items) => {
        if (active) setReferences(items);
      })
      .catch(notify.error);
    return () => {
      active = false;
    };
  }, [page, launcher]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        notify.error(error);
    } finally {
      setBusy(false);
    }
  };
  const open = async (destination: WorkspaceDestination) => {
    try {
      await onOpen(destination);
    } catch (error) {
      setPage(undefined);
      throw error;
    }
  };
  if (!page)
    return (
      <StartScreen
        busy={busy}
        actions={(["create", "join", "manage"] as const).map((value) => ({
          title: value[0].toUpperCase() + value.slice(1),
          onSelect: () => {
            if (value === "manage")
              void run(async () => {
                await launcher.refresh();
                setPage(value);
              });
            else setPage(value);
          },
        }))}
      />
    );
  const reference = references.find(
    (item) => item.workspace + "/" + item.id === existing,
  );
  const workspaceShare = preview?.kind === "workspace";
  const scoped = preview?.kind === "file" || preview?.kind === "folder";
  const valid =
    !!inspected &&
    (workspaceShare
      ? validWorkspace(workspace) && Object.values(children).every(validVault)
      : scoped && mode === "existing"
        ? !!reference
        : validVault(vault) && vault.kind !== "none");
  return (
    <main
      data-start-screen
      className="min-h-dvh flex items-center justify-center px-6 py-12"
    >
      <div className="w-full max-w-xl space-y-6" aria-busy={busy}>
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            disabled={busy}
            onClick={() => setPage(undefined)}
          >
            <ArrowLeft />
          </Button>
          <h1 className="text-xl font-semibold">
            {page === "create"
              ? "Create workspace"
              : page === "join"
                ? "Join a share"
                : "Manage workspaces"}
          </h1>
        </div>
        {page === "manage" ? (
          <WorkspaceManage
            launcher={launcher}
            busy={busy}
            onOpen={(id) => run(() => open({ id }))}
          />
        ) : page === "create" ? (
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (validWorkspace(workspace) && !busy)
                void run(() => open({ create: workspace }));
            }}
          >
            <WorkspaceDestinationFields
              launcher={launcher}
              value={workspace}
              onChange={setWorkspace}
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !validWorkspace(workspace)}>
              Create workspace
            </Button>
          </form>
        ) : (
          <div className="space-y-6">
            <label className="block space-y-2 text-sm">
              Sync link
              <Input
                aria-label="Sync link"
                placeholder="saddle://share/…"
                value={link}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => {
                  const value = event.target.value;
                  setLink(value);
                  setInspected(undefined);
                  setChildren({});
                  try {
                    const next = parseShareLink(value);
                    setPreview(next);
                    setWorkspace({ ...emptyWorkspace(), name: next.name });
                    setVault({
                      kind: "internal",
                      name: next.name.split("/").pop() ?? next.name,
                    });
                  } catch {
                    setPreview(undefined);
                  }
                }}
              />
            </label>
            <Button
              variant="outline"
              disabled={busy || !link.trim()}
              onClick={() =>
                void run(async () => {
                  parseShareLink(link);
                  const share = await launcher.inspect(link);
                  setInspected(share);
                  if (share.kind === "workspace")
                    setChildren(
                      Object.fromEntries(
                        Object.entries(share.vaults).map(([id, child]) => [
                          id,
                          { kind: "internal", name: child.name },
                        ]),
                      ),
                    );
                })
              }
            >
              Inspect link
            </Button>
            {preview && (
              <form
                className="space-y-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!valid || busy) return;
                  void run(() =>
                    open({
                      invitation: {
                        link,
                        workspace: workspaceShare
                          ? workspace
                          : { kind: "internal", name: preview.name },
                        vault,
                        children: workspaceShare ? children : undefined,
                        existing:
                          scoped && mode === "existing" && reference
                            ? {
                                workspace: reference.workspace,
                                id: reference.id,
                                location: reference.location,
                              }
                            : undefined,
                      },
                    }),
                  );
                }}
              >
                <p className="text-sm text-muted-foreground">
                  {preview.name} · {preview.kind}
                  {!inspected && " · Inspect the link to verify access."}
                </p>
                {workspaceShare ? (
                  <>
                    <WorkspaceDestinationFields
                      launcher={launcher}
                      value={workspace}
                      onChange={setWorkspace}
                      disabled={busy}
                      showVault={
                        !inspected || !Object.keys(inspected.vaults).length
                      }
                    />
                    {inspected &&
                      Object.entries(inspected.vaults).map(([id, child]) => (
                        <VaultDestinationFields
                          key={id}
                          launcher={launcher}
                          label={`Shared vault: ${child.name}`}
                          value={
                            children[id] ?? { kind: "none", name: child.name }
                          }
                          onChange={(value) =>
                            setChildren((prior) => ({ ...prior, [id]: value }))
                          }
                          disabled={busy}
                        />
                      ))}
                  </>
                ) : (
                  <>
                    {scoped && (
                      <StorageChoice<"new" | "existing">
                        label="Destination vault"
                        value={mode}
                        onChange={setMode}
                        disabled={busy}
                        options={[
                          { value: "new", label: "Create vault" },
                          { value: "existing", label: "Select vault" },
                        ]}
                      />
                    )}
                    {scoped && mode === "existing" ? (
                      <label className="block space-y-2 text-sm">
                        Stored vault references
                        <ChoiceSelect
                          aria-label="Stored vault references"
                          value={existing}
                          onValueChange={setExisting}
                          options={references.map((item) => ({
                            value: item.workspace + "/" + item.id,
                            label: `${item.name} · ${item.workspaceName}`,
                          }))}
                        />
                        {!references.length && (
                          <p className="text-muted-foreground">
                            No stored vault references.
                          </p>
                        )}
                      </label>
                    ) : (
                      <>
                        <VaultDestinationFields
                          launcher={launcher}
                          value={vault}
                          onChange={setVault}
                          allowNone={false}
                          disabled={busy}
                        />
                        <p className="text-sm text-muted-foreground">
                          A new internal workspace will contain this vault.
                        </p>
                      </>
                    )}
                  </>
                )}
                <Button type="submit" disabled={busy || !valid}>
                  Join share
                </Button>
              </form>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
