import { useState, useSyncExternalStore } from "react";
import type { AppRuntime } from "./runtime";
import { WorkspaceSettings } from "../core/workspace-settings";
import { Button } from "../ui/primitives/button";
import { SharedTextarea } from "../ui/html-controls";
import { notify } from "../ui/notifications";

export function SharedWorkspaceSettings({ runtime }: { runtime: AppRuntime }) {
  useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
  );
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const value = JSON.stringify(
    new WorkspaceSettings(runtime.node.replica).read(),
    null,
    2,
  );
  return (
    <section className="settings-card space-y-3">
      <h2>Shared settings</h2>
      <p className="text-sm text-muted-foreground">
        Plugins and workspace home sync to every device. Theme, shortcuts,
        selected schema, storage paths and device permissions stay local.
      </p>
      <label className="field-row">
        Workspace settings (JSON)
        <SharedTextarea
          aria-label="Workspace settings (JSON)"
          className="core-input min-h-40 max-h-80 font-mono"
          value={draft ?? value}
          disabled={!runtime.node.records.canWrite() || busy}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button
          disabled={
            draft === undefined || busy || !runtime.node.records.canWrite()
          }
          onClick={async () => {
            setBusy(true);
            try {
              await runtime.saveWorkspaceSettings(JSON.parse(draft!));
              setDraft(undefined);
              notify.success("Shared settings saved.");
            } catch (error) {
              notify.error(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save shared settings
        </Button>
        {draft !== undefined && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setDraft(undefined)}
          >
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}
