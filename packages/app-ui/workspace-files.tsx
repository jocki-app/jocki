import { useState } from "react";
import { exportWorkspace, importWorkspace } from "../core/workspace-package";
import { browserDevice } from "../platform-browser/device";
import {
  profileForNode,
  type AppRuntime,
  type WorkspaceProfile,
} from "./runtime";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { download } from "./download";
import { notify } from "../ui/notifications";
export function OpenWorkspaceFile({
  onOpen,
  disabled = false,
  onBusyChange,
}: {
  onOpen(profile: WorkspaceProfile): Promise<void>;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="block space-y-2">
      Import Automerge bundle
      <Input
        aria-label="Import Automerge bundle"
        type="file"
        accept=".automerge,.bundle,application/octet-stream"
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          onBusyChange?.(true);
          void (async () => {
            const node = await importWorkspace(
              await browserDevice(),
              new Uint8Array(await file.arrayBuffer()),
            );
            await onOpen(await profileForNode(node));
          })()
            .catch((error) => notify.error(String(error)))
            .finally(() => {
              setBusy(false);
              onBusyChange?.(false);
            });
        }}
      />
      <span className="text-sm text-muted-foreground">
        Imports an .automerge bundle as a separate workspace. Reconnect saved
        credentials after importing. Use Join to connect to the original
        workspace.
      </span>
    </label>
  );
}
export function WorkspaceFileSettings({ runtime }: { runtime: AppRuntime }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="space-y-3">
      <h2>Workspace storage</h2>
      <p className="text-sm text-muted-foreground">
        Automerge Repo saves changes automatically. Browsers and mobile apps use
        IndexedDB; desktop and headless Node apps use a directory. Network
        synchronization is configured in Devices.
      </p>
      <p className="text-sm text-muted-foreground">
        Export a portable, unencrypted Automerge bundle of workspace records and
        files. Credential secret documents and identity keys are excluded.
      </p>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void exportWorkspace(runtime.node)
            .then((bytes) =>
              download(
                runtime.profile.name + ".automerge",
                new Blob([bytes as Uint8Array<ArrayBuffer>], {
                  type: "application/octet-stream",
                }),
              ),
            )
            .catch((error) => notify.error(String(error)))
            .finally(() => setBusy(false));
        }}
      >
        Export Automerge bundle
      </Button>
    </section>
  );
}
