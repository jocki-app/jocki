import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  VaultLauncher,
  VaultRuntime,
} from "../platform-browser/vault-runtime";
import { LoadingSpinner } from "../ui/loading-spinner";
import Application from "./vault-app";
import { VaultStart, type WorkspaceDestination } from "./vault-start";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import { LogsPage } from "./vault-settings-pages";

/** No workspace is loaded until the user selects Create, Join or Open. */
export function VaultEntry({ launcher }: { launcher: VaultLauncher }) {
  const [session, setSession] = useState<{
      runtime: VaultRuntime;
    }>(),
    [error, setError] = useState(""),
    [closing, setClosing] = useState(false),
    [logsOpen, setLogsOpen] = useState(false);
  const current = useRef<VaultRuntime | undefined>(undefined),
    transitioning = useRef(false);
  useEffect(() => {
    const openLogs = () => {
      if (!current.current) setLogsOpen(true);
    };
    window.addEventListener("jocki:open-logs", openLogs);
    return () => window.removeEventListener("jocki:open-logs", openLogs);
  }, []);
  const navigate = async (
    destination: WorkspaceDestination = {},
    failure = "",
  ) => {
    if (transitioning.current) return;
    transitioning.current = true;
    try {
      const previous = current.current;
      if (previous) {
        if (previous.confirmClose && !(await previous.confirmClose())) return;
        flushSync(() => {
          setSession(undefined);
          setClosing(true);
        });
        current.current = undefined;
        await previous.shutdown();
      }
      await launcher.refresh();
      setError(failure);
      if (
        !destination.id &&
        !destination.name &&
        !destination.create &&
        !destination.invitation
      )
        return;
      const runtime = destination.invitation
        ? await launcher.join(destination.invitation)
        : destination.create || destination.name
          ? await launcher.create(destination.create ?? destination.name!)
          : await launcher.open(destination.id!);
      runtime.navigate = (next) => navigate(next);
      runtime.subscribeOpenErrors(() => {
        void navigate({}, runtime.openError).catch(() => {});
      });
      current.current = runtime;
      setSession({ runtime });
      setLogsOpen(false);
      setError("");
    } catch (error) {
      await launcher.refresh().catch(() => {});
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      transitioning.current = false;
      setClosing(false);
    }
  };
  if (closing)
    return <LoadingSpinner label="Closing workspace…" className="min-h-dvh" />;
  if (session)
    return (
      <Application
        key={session.runtime.workspace.current.id}
        runtime={session.runtime}
        onHome={() => void navigate().catch(() => {})}
      />
    );
  return (
    <>
      <VaultStart launcher={launcher} error={error} onOpen={navigate} />
      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="sm:max-w-5xl max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Local logs</DialogTitle>
          </DialogHeader>
          {logsOpen && <LogsPage runtime={{ logs: launcher.logs }} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
