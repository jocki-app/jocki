import { WorkspaceIcon } from "./workspace-icon";
import { shareLink } from "../core/vaults/share-invitation";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { ChoiceSelect } from "../ui/choice-select";
import { Switch } from "../ui/primitives/switch";
import { shareRowEnabled } from "./vault-scope-counts";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { FileVault } from "../core/vaults/vault";
import type {
  ShareDocument,
  ShareInvitation,
  ShareSummary,
} from "../core/vaults/protected-sync";
import { relayPresets, selectRelay } from "../core/relay-settings";
import { SettingsPage } from "./vault-settings-pages";
import { FeatureControl } from "./vault-feature-controls";
import { featureOverride, type FeatureTarget } from "./vault-feature-model";
import { FeatureOverview } from "./vault-feature-overview";
import { useReportedError } from "./errors";

function useConnection(runtime: VaultRuntime) {
  const [connection, setConnection] = useState(runtime.connectionSettings);
  useEffect(
    () =>
      runtime.subscribeConnection(() =>
        setConnection(runtime.connectionSettings),
      ),
    [runtime],
  );
  return connection;
}
function scopeBroadcastEnabled(runtime: VaultRuntime, share: ShareSummary) {
  if (!shareRowEnabled(runtime, share)) return false;
  if (share.invitation.kind === "workspace")
    return runtime.workspace.features.sync;
  const vault = runtime.vaults.get(share.vault!);
  if (!vault) return false;
  return share.invitation.kind === "file"
    ? !!share.rootFile && vault.syncEnabled(share.rootFile)
    : vault.folderFeatures(share.prefix).sync;
}
async function broadcastShare(
  runtime: VaultRuntime,
  share: ShareSummary,
  enabled: boolean,
) {
  if (enabled && !scopeBroadcastEnabled(runtime, share))
    throw Error("Enable Sharing on this item before turning on Broadcast");
  await (await runtime.startSync()).setBroadcast(share.invitation, enabled);
}
function useShares(runtime: VaultRuntime) {
  const [shares, setShares] = useState<ShareSummary[]>([]),
    [, report] = useReportedError("sharing");
  const refresh = async () => {
    const sync = runtime.sync;
    try {
      const found = sync ? await sync.listShares() : [];
      if (runtime.sync === sync) setShares(found);
    } catch (error) {
      if (runtime.sync === sync) throw error;
    }
  };
  useEffect(() => {
    void refresh().catch(report);
    const remove = runtime.subscribeConnection(
      () => void refresh().catch(report),
    );
    const timer = setInterval(() => void refresh().catch(report), 2000);
    return () => {
      remove();
      clearInterval(timer);
    };
  }, [runtime]);
  return { shares, refresh };
}
function scopePath(runtime: VaultRuntime, share: ShareSummary) {
  if (share.invitation.kind === "file" && share.rootFile) {
    try {
      return runtime.vaults.get(share.vault!)!.entry(share.rootFile).path;
    } catch {}
  }
  return share.prefix;
}
function ShareTable({
  runtime,
  shares,
  onOpen,
  onRemove,
  onChanged,
  addRow,
}: {
  runtime: VaultRuntime;
  shares: ShareSummary[];
  onOpen(share: ShareSummary): void;
  onRemove(share: ShareSummary): void;
  onChanged(): Promise<void>;
  addRow?: ReactNode;
}) {
  const connection = useConnection(runtime),
    [busy, setBusy] = useState(false),
    [, refresh] = useState(0);
  const [, report] = useReportedError("sharing-broadcast");
  const change = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await onChanged();
      refresh((value) => value + 1);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Table aria-label="Active shares">
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>Shared with</TableHead>
          <TableHead>Access</TableHead>
          <TableHead>
            <div className="flex items-center gap-2">
              Broadcast
              <Switch
                aria-label="Broadcast all sharings"
                checked={connection.broadcast}
                disabled={busy}
                onCheckedChange={(broadcast) =>
                  void change(() =>
                    runtime.configureConnection({
                      ...runtime.connectionSettings,
                      broadcast,
                    }),
                  )
                }
              />
            </div>
          </TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {addRow}
        {shares.map((share) => (
          <TableRow key={share.invitation.url} onClick={() => onOpen(share)}>
            <TableCell>
              <Button
                variant="link"
                className="h-auto max-w-full justify-start px-0"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(share);
                }}
              >
                {share.invitation.kind === "workspace" && <WorkspaceIcon />}
                <span className="truncate">
                  {share.invitation.kind === "workspace"
                    ? runtime.workspace.current.name
                    : `${runtime.vaults.get(share.vault!)?.name ?? "Vault"}${scopePath(runtime, share) ? "/" + scopePath(runtime, share) : ""}`}
                </span>
                <ExternalLink className="size-3" />
              </Button>
              <p className="text-xs text-muted-foreground">
                {share.invitation.kind}
              </p>
            </TableCell>
            <TableCell className="text-xs">
              {share.members
                .filter((m) => !m.self)
                .map((m) => m.id.slice(0, 12))
                .join(", ") || "This computer"}
            </TableCell>
            <TableCell>
              {share.owner
                ? "Owner"
                : share.role === "edit"
                  ? "Can edit"
                  : "Can read"}
            </TableCell>
            <TableCell onClick={(event) => event.stopPropagation()}>
              <Switch
                aria-label={`Broadcast ${share.invitation.kind}: ${share.invitation.name}`}
                checked={
                  connection.broadcast &&
                  share.broadcast &&
                  scopeBroadcastEnabled(runtime, share)
                }
                disabled={
                  busy ||
                  !connection.broadcast ||
                  !scopeBroadcastEnabled(runtime, share)
                }
                title={
                  connection.broadcast
                    ? undefined
                    : "Broadcast is paused for this app"
                }
                onCheckedChange={(enabled) =>
                  void change(() => broadcastShare(runtime, share, enabled))
                }
              />
            </TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Disconnect ${share.invitation.name}`}
                title="Disconnect sharing; keep every computer's files"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(share);
                }}
              >
                <Trash2 />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function shareTarget(runtime: VaultRuntime, share: ShareSummary) {
  return {
    vault: share.vault ? runtime.vaults.get(share.vault) : undefined,
    path: scopePath(runtime, share),
    id:
      share.invitation.kind === "file"
        ? (share.rootFile ?? undefined)
        : undefined,
  };
}

/** The context fixes the resource being shared. Descendant/parent grants have their own dialogs. */
export function VaultSharing({
  runtime,
  vault,
  file,
  folder = false,
  onOpen,
}: {
  runtime: VaultRuntime;
  vault?: FileVault;
  file?: string;
  folder?: boolean;
  onOpen(target: FeatureTarget): void;
}) {
  const kind = !vault
      ? "workspace"
      : folder
        ? "folder"
        : file
          ? "file"
          : "vault",
    path = file ?? "";
  const { shares, refresh } = useShares(runtime),
    [contact, setContact] = useState(""),
    [access, setAccess] = useState<"read" | "edit">("edit"),
    [invitation, setInvitation] = useState<ShareInvitation>(),
    [busy, setBusy] = useState(false);
  const connection = useConnection(runtime);
  useSyncExternalStore(
    (listener) =>
      vault?.subscribe(listener) ?? runtime.workspace.subscribe(listener),
    () => vault?.version ?? runtime.workspace.current,
  );
  const ownSetting = vault
    ? featureOverride(
        { vault, path, id: kind === "file" ? vault.find(path)?.id : undefined },
        "sync",
      )
    : runtime.workspace.current.features.sync;
  const [, report] = useReportedError("sharing");
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const exact = (s: ShareSummary) =>
    s.invitation.kind === kind &&
    (kind === "workspace" ||
      (s.vault === vault?.id && scopePath(runtime, s) === path));
  const current = shares.filter(exact),
    owned = current.find((s) => s.owner);
  const related = shares.filter((s) =>
    kind === "workspace"
      ? s.vault === null || runtime.vaults.has(s.vault)
      : s.invitation.kind === "workspace" ||
        (s.vault === vault?.id &&
          (kind === "vault" ||
            scopePath(runtime, s) === path ||
            s.invitation.kind === "vault" ||
            (s.invitation.kind === "folder" &&
              path.startsWith(scopePath(runtime, s) + "/")) ||
            (kind === "folder" &&
              scopePath(runtime, s).startsWith(path + "/")))),
  );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-share-item={kind + ":" + path}
    >
      <FeatureOverview
        runtime={runtime}
        vault={vault}
        path={path}
        id={kind === "file" ? vault?.find(path)?.id : undefined}
        feature="sync"
        shares={shares}
        broadcast={connection.broadcast}
        onOpen={onOpen}
      >
        <div className="space-y-5">
          <div className="flex justify-end">
            <FeatureControl
              runtime={runtime}
              vault={vault}
              path={path}
              id={kind === "file" ? vault?.find(path)?.id : undefined}
              feature="sync"
            />
          </div>
          {ownSetting === true ? (
            <ShareTable
              runtime={runtime}
              shares={related}
              onOpen={(share) => onOpen(shareTarget(runtime, share))}
              onRemove={(share) =>
                void run(() => runtime.sync!.disconnect(share.invitation))
              }
              onChanged={refresh}
              addRow={
                <TableRow data-add-access>
                  <TableCell
                    className="max-w-48 truncate"
                    title={
                      path || vault?.name || runtime.workspace.current.name
                    }
                  >
                    {path || vault?.name || runtime.workspace.current.name}
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label="Recipient contact card"
                      placeholder="Recipient contact card"
                      value={contact}
                      onChange={(event) => setContact(event.target.value)}
                      className="min-w-36"
                    />
                  </TableCell>
                  <TableCell>
                    <ChoiceSelect
                      aria-label="Access"
                      value={access}
                      onValueChange={(value) =>
                        setAccess(value as "read" | "edit")
                      }
                      options={[
                        { value: "edit", label: "Can edit" },
                        { value: "read", label: "Can read" },
                      ]}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground">—</TableCell>
                  <TableCell>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="Add access"
                      title="Add access"
                      disabled={
                        busy || !connection.broadcast || !contact.trim()
                      }
                      onClick={() =>
                        void run(async () => {
                          const sync = await runtime.startSync();
                          const created =
                            owned?.invitation ??
                            (kind === "workspace"
                              ? await sync.createWorkspace([
                                  ...runtime.vaults.values(),
                                ])
                              : await sync.create(vault!, kind, path));
                          await sync.grant(created, contact, access);
                          setInvitation(created);
                          setContact("");
                        })
                      }
                    >
                      <Plus />
                    </Button>
                  </TableCell>
                </TableRow>
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {ownSetting === false
                ? "Sharing is disabled."
                : "No shares defined here."}
            </p>
          )}
          {ownSetting === true && owned && (
            <section className="space-y-2">
              <h3 className="font-medium">Access to this item</h3>
              {owned.members
                .filter((m) => !m.self && m.access !== "admin")
                .map((member) => (
                  <div className="flex items-center gap-2" key={member.id}>
                    <span
                      className="min-w-0 flex-1 truncate text-xs"
                      title={member.id}
                    >
                      {member.id}
                    </span>
                    <ChoiceSelect
                      aria-label={`Access for ${member.id}`}
                      value={member.access}
                      onValueChange={(value) =>
                        void run(() =>
                          runtime.sync!.setAccess(
                            owned.invitation,
                            member.id,
                            value as "read" | "edit",
                          ),
                        )
                      }
                      options={[
                        { value: "read", label: "Can read" },
                        { value: "edit", label: "Can edit" },
                      ]}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove access for ${member.id}`}
                      onClick={() =>
                        void run(() =>
                          runtime.sync!.revoke(owned.invitation, member.id),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
            </section>
          )}
          {ownSetting === true && (invitation || owned) && (
            <label className="block space-y-2">
              Invitation
              <div className="flex items-start gap-2">
                <Textarea
                  aria-label="Share invitation"
                  readOnly
                  value={shareLink(invitation ?? owned!.invitation)}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Copy invitation"
                  onClick={() =>
                    void run(() =>
                      navigator.clipboard.writeText(
                        shareLink(invitation ?? owned!.invitation),
                      ),
                    )
                  }
                >
                  <Copy />
                </Button>
              </div>
            </label>
          )}
        </div>
      </FeatureOverview>
    </div>
  );
}

/** Workspace-wide connection/invitation management is separate from item sharing. */
export function SharingSettings({
  runtime,
  onOpen,
}: {
  runtime: VaultRuntime;
  onOpen(target: FeatureTarget): void;
}) {
  const { shares, refresh } = useShares(runtime),
    [incoming, setIncoming] = useState(""),
    [inspected, setInspected] = useState<ShareDocument>(),
    [destination, setDestination] = useState(
      [...runtime.vaults.keys()][0] ?? "",
    ),
    [prefix, setPrefix] = useState(""),
    [card, setCard] = useState(""),
    [busy, setBusy] = useState(false),
    [mapped, setMapped] = useState<Record<string, string>>({});
  const connection = useConnection(runtime);
  const [, report] = useReportedError("sharing-settings");
  useEffect(() => {
    void runtime.startSync().then(refresh).catch(report);
  }, [runtime]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const shown = shares.filter(
    (s) => s.vault === null || runtime.vaults.has(s.vault),
  );
  return (
    <SettingsPage
      title="Sharing"
      description="Active shares across the open vaults. Files remain on each computer when a share is disconnected."
    >
      <ShareTable
        runtime={runtime}
        shares={shown}
        onOpen={(share) => onOpen(shareTarget(runtime, share))}
        onRemove={(s) => void run(() => runtime.sync!.disconnect(s.invitation))}
        onChanged={refresh}
      />
      {!shown.length && <p>No active shares.</p>}
      <section className="space-y-3">
        <h2 className="font-semibold">Connection</h2>
        <ChoiceSelect
          aria-label="Sync connection"
          value={connection.selected}
          disabled={busy}
          onValueChange={(id) =>
            void run(async () => {
              const selected = selectRelay(connection, id);
              await runtime.configureConnection(selected);
            })
          }
          placeholder="Choose connection"
          options={[
            ...relayPresets.map((relay) => ({
              value: relay.id,
              label: relay.name,
            })),
            ...connection.saved.map((relay) => ({
              value: relay.id,
              label: relay.name,
            })),
            ...(connection.selected === "custom"
              ? [{ value: "custom", label: "Custom relay" }]
              : []),
          ]}
        />
        <p className="text-sm text-muted-foreground">
          Broadcast in the table header controls this app's connections. Row
          switches choose which shared scopes exchange changes. Turning
          Broadcast off preserves those choices. Changing the relay reconnects
          automatically.
        </p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setCard((await runtime.startSync()).repository.contactCard),
            )
          }
        >
          Show this computer's contact card
        </Button>
        {card && (
          <Textarea
            aria-label="This computer contact card"
            readOnly
            value={card}
          />
        )}
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Open an invitation</h2>
        <Textarea
          aria-label="Incoming invitation"
          value={incoming}
          onChange={(e) => {
            setIncoming(e.target.value);
            setInspected(undefined);
          }}
        />
        <Button
          variant="outline"
          disabled={busy || !connection.broadcast || !incoming.trim()}
          onClick={() =>
            void run(async () => {
              const scope = await (
                await runtime.startSync()
              ).inspectInvitation(incoming);
              setInspected(scope.doc());
              setPrefix(
                scope.doc().kind === "folder"
                  ? scope.doc().name.split("/").pop()!
                  : "/",
              );
            })
          }
        >
          Inspect invitation
        </Button>
        {inspected && (
          <div className="space-y-3">
            <p>
              {inspected.name} · {inspected.kind}
            </p>
            {inspected.kind === "workspace" ? (
              <>
                {Object.entries(inspected.vaults).map(([id, child]) => (
                  <label key={id} className="block space-y-1">
                    {child.name}
                    <ChoiceSelect
                      aria-label={`Destination for ${child.name}`}
                      value={mapped[id] ?? ""}
                      onValueChange={(value) =>
                        setMapped((prior) => ({ ...prior, [id]: value }))
                      }
                      options={[
                        { value: "", label: "Skip on this computer" },
                        ...[...runtime.vaults.values()].map((v) => ({
                          value: v.id,
                          label: v.name,
                        })),
                      ]}
                    />
                  </label>
                ))}
              </>
            ) : (
              <>
                <label className="block space-y-1">
                  Destination vault
                  <ChoiceSelect
                    aria-label="Destination vault"
                    value={destination}
                    onValueChange={setDestination}
                    options={[...runtime.vaults.values()].map((v) => ({
                      value: v.id,
                      label: v.name,
                    }))}
                  />
                </label>
                {inspected.kind !== "vault" && (
                  <label className="block space-y-1">
                    Destination folder
                    <Input
                      aria-label="Destination folder"
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                      placeholder="/ for the vault root"
                    />
                  </label>
                )}
                <p className="text-xs text-muted-foreground">
                  Choose where these files will live here. Existing unrelated
                  files are never overwritten.
                </p>
              </>
            )}
            <Button
              disabled={
                busy ||
                (inspected.kind !== "workspace" &&
                  (!destination || !prefix.trim()))
              }
              onClick={() =>
                void run(async () => {
                  if (inspected.kind === "workspace") {
                    runtime.assertWorkspaceCanChange();
                    const chosen = Object.entries(mapped).filter(
                      ([, id]) => id,
                    );
                    if (
                      new Set(chosen.map(([, id]) => id)).size !== chosen.length
                    )
                      throw Error(
                        "Use a separate destination vault for each shared vault",
                      );
                    for (const [id, localId] of chosen) {
                      const child = inspected.vaults[id];
                      await runtime.joinShare(
                        shareLink({
                          format: "saddle-share-invitation/1",
                          url: child.url,
                          name: child.name,
                          kind: "vault",
                        }),
                        runtime.vaults.get(localId)!,
                      );
                    }
                    const mounts = runtime.workspace.settings(
                      runtime.computer,
                    ).vaults;
                    await runtime.joinWorkspace(
                      incoming,
                      Object.fromEntries(
                        chosen.map(([id]) => [id, mounts[id]]),
                      ),
                    );
                  } else {
                    const target = runtime.vaults.get(destination);
                    if (!target) throw Error("Open a destination vault first");
                    await runtime.joinShare(
                      incoming,
                      target,
                      prefix.trim() === "/" ? "" : prefix.trim(),
                    );
                  }
                  setInspected(undefined);
                  setIncoming("");
                })
              }
            >
              Open share here
            </Button>
          </div>
        )}
      </section>
    </SettingsPage>
  );
}
