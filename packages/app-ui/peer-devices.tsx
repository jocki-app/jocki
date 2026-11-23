import { RepositoryConnectionSettings } from "./repository-settings";
import { notify } from "../ui/notifications";
import { SharedInput, SharedTextarea } from "../ui/html-controls";
import { useState, useEffect, useSyncExternalStore } from "react";
import type { NativeInfo } from "./network";
import type { AppRuntime } from "./runtime";
import { membership } from "../core/membership";
import { readDeviceRequest } from "../core/pairing";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/primitives/dialog";
import { Button } from "../ui/primitives/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
export function PeerDevicesView({ runtime }: { runtime: AppRuntime }) {
  useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
    () => 0,
  );
  const [request, setRequest] = useState(""),
    [invitation, setInvitation] = useState(""),
    [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false);
  const policy = membership(runtime.node.replica.access),
    self = runtime.device.identity.id,
    status = runtime.node.replica.status();
  let requested: ReturnType<typeof readDeviceRequest> | undefined;
  try {
    if (request.trim()) requested = readDeviceRequest(request);
  } catch {}
  const wrongWorkspace =
    requested?.workspaceId &&
    requested.workspaceId !== runtime.profile.workspaceId;
  const [native, setNative] = useState<NativeInfo>(),
    [missing, setMissing] = useState(0);
  useEffect(() => {
    void window.jockiNative?.peer.info().then(setNative);
    void runtime.node.protocol.files
      .missing()
      .then((v) => setMissing(v.length));
  }, [runtime, runtime.surfacesVersion]);
  async function act(
    work: () => Promise<void>,
    message = "Device settings updated.",
  ) {
    setBusy(true);

    try {
      await work();
      notify.success(message);
      runtime.notifySurfaces();
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <RepositoryConnectionSettings />

      <div className="settings-card">
        <p>
          {status.documents} local documents · {status.peers} online peers ·{" "}
          {missing} file chunks still downloading
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Actions</TableHead>
            <TableHead>Device</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Connection</TableHead>
            <TableHead>Capabilities</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.values(policy.members).map((member) => {
            const peer = runtime.node.peerDevices.get(member.identity.id),
              local = member.identity.id === self;
            return (
              <TableRow key={member.identity.id}>
                <TableCell>
                  {policy.members[self]?.admin && !local && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          runtime.device.revoke(
                            runtime.profile.workspaceId,
                            member.identity.id,
                          ),
                        )
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
                <TableCell>
                  {member.identity.name}
                  {local ? " (this device)" : ""}
                </TableCell>
                <TableCell>
                  {member.access === "write" ? "Write" : "Read"}
                </TableCell>
                <TableCell>
                  {local
                    ? "Local"
                    : peer && Date.now() - peer.lastSeen < 45000
                      ? "Online"
                      : "Offline"}
                </TableCell>
                <TableCell>
                  {local
                    ? "Local records and files"
                    : (peer?.capabilities.join(", ") ??
                      "Available when connected")}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <section className="settings-card space-y-3">
        <h2>Automations in this app</h2>
        <p className="text-sm">
          Run on this device while the app is active. Checkpoints survive
          restarts. Phones and browsers pause execution when suspended.
        </p>
        <label className="flex gap-2">
          <SharedInput
            type="checkbox"
            checked={runtime.automationOptions.enabled}
            onChange={(e) =>
              void act(() =>
                runtime.configureAutomation({
                  ...runtime.automationOptions,
                  enabled: e.target.checked,
                }),
              )
            }
          />
          Enable local automation execution
        </label>
        <label className="flex gap-2">
          <SharedInput
            type="checkbox"
            checked={runtime.automationOptions.trustedCode}
            onChange={(e) =>
              void act(() =>
                runtime.configureAutomation({
                  ...runtime.automationOptions,
                  trustedCode: e.target.checked,
                }),
              )
            }
          />
          Allow trusted TypeScript code in an isolated worker
        </label>
      </section>
      {native && (
        <section className="settings-card space-y-3">
          <h2>This computer’s capabilities</h2>
          <p className="text-sm">
            These services keep running in the tray when you close the window.
            Quit Jocki to stop them.
          </p>
          {(
            [
              "terminal",
              "automation",
              "trustedCode",
              "background",
              "plugins",
            ] as const
          ).map((key) => (
            <label key={key} className="flex items-center gap-2">
              <SharedInput
                type="checkbox"
                checked={native.options[key]}
                disabled={busy}
                onChange={(e) =>
                  void act(async () => {
                    setNative(
                      await window.jockiNative!.peer.configure({
                        ...native.options,
                        [key]: e.target.checked,
                      }),
                    );
                  })
                }
              />
              {
                {
                  terminal: "Incoming terminal access",
                  automation: "Run automations",
                  trustedCode: "Run trusted TypeScript code",
                  background: "Scheduled plugin services",
                  plugins: "Install active workspace plugins on this computer",
                }[key]
              }
            </label>
          ))}
        </section>
      )}
      <section className="settings-card space-y-3">
        <h2>Plugin installation in this app</h2>
        <p className="text-sm">
          Active plugins follow the workspace. Missing verified packages are
          installed when this app opens or syncs.
        </p>
        <label className="flex items-center gap-2">
          <SharedInput
            type="checkbox"
            checked={runtime.allowRemotePlugins}
            disabled={busy}
            onChange={(e) =>
              void act(() => runtime.configureRemotePlugins(e.target.checked))
            }
          />
          Allow remote plugin installation by devices with write access
        </label>
      </section>
      {policy.members[self]?.admin && (
        <section className="settings-card space-y-3">
          <h2>Approve another device</h2>
          <p className="text-sm">
            Approve a request from the other device’s Join workspace page.
          </p>
          <Button
            onClick={() => {
              setRequest("");
              setAdding(true);
            }}
          >
            Add device
          </Button>
        </section>
      )}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!busy) {
            setAdding(open);
            if (!open) setRequest("");
          }
        }}
      >
        <DialogContent className="pairing-dialog">
          <DialogHeader>
            <DialogTitle>Approve another device</DialogTitle>
            <DialogDescription>
              Paste the device request to review its name and access.
            </DialogDescription>
          </DialogHeader>
          <label className="field-row">
            Device request
            <SharedTextarea
              className="core-input pairing-text min-h-24"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
          </label>
          {requested && (
            <p className="break-words">
              {requested.identity.name} is requesting {requested.access} access
              to {policy.name}.
            </p>
          )}
          {request.trim() && !requested && (
            <p role="status" className="text-sm text-destructive">
              Paste a valid device request.
            </p>
          )}
          {wrongWorkspace && (
            <p role="status" className="text-sm text-destructive">
              This request is for another workspace.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setRequest("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !requested || Boolean(wrongWorkspace)}
              onClick={() =>
                void act(async () => {
                  setInvitation(
                    await runtime.device.approve(
                      runtime.profile.workspaceId,
                      request,
                    ),
                  );
                  setAdding(false);
                  setRequest("");
                }, "Device approved.")
              }
            >
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(invitation)}
        onOpenChange={(open) => {
          if (!open) setInvitation("");
        }}
      >
        <DialogContent className="pairing-dialog">
          <DialogHeader>
            <DialogTitle>Copy invitation</DialogTitle>
            <DialogDescription>
              Copy this JSON invitation to the requesting device. Keep this
              workspace open and online until it joins. The invitation is only
              shown here once.
            </DialogDescription>
          </DialogHeader>
          <label className="field-row">
            Invitation JSON
            <SharedTextarea
              readOnly
              className="core-input pairing-text min-h-24"
              value={invitation}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await navigator.clipboard.writeText(invitation);
                setInvitation("");
              }, "Invitation copied.")
            }
          >
            Copy invitation
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
