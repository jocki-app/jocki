import { useReportedError } from "./errors";
import { RepositoryConnectionSettings } from "./repository-settings";
import { LoadingSpinner } from "../ui/loading-spinner";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Separator } from "../ui/primitives/separator";
import { WorkspacePicker } from "./workspace-picker";
import {
  createLocalWorkspace,
  joinWorkspace,
  profiles,
  browserDevice,
  type WorkspaceProfile,
} from "./runtime";
import { OpenWorkspaceFile } from "./workspace-files";
import { JoinWorkspaceForm } from "./join-workspace-form";
import { StartScreen } from "./start-screen";
export const activeWorkspaceKey = "jocki.active-workspace";
type StartPage = "create" | "join" | "open";
const descriptions: Record<StartPage, string> = {
  create: "Create a workspace on this device. Your changes save automatically.",
  join: "Join a workspace shared with this device.",
  open: "Open a saved workspace or import a portable workspace bundle.",
};
export function Welcome({
  onOpen,
  error: externalError,
}: {
  onOpen(profile: WorkspaceProfile): Promise<void>;
  error: string;
}) {
  const [page, setPage] = useState<StartPage>(),
    [name, setName] = useState(""),
    [request, setRequest] = useState(""),
    [saved, setSaved] = useState<WorkspaceProfile[]>([]),
    [, setError] = useReportedError("welcome"),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState("");
  useEffect(() => setError(externalError), [externalError]);
  const run = async (work: () => Promise<void>, message = "") => {
    setBusy(true);
    setProgress(message);
    setError("");
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  async function choose(next: StartPage) {
    setPage(next);
    if (next === "open") setSaved(await profiles());
    if (next === "join") setRequest((await browserDevice()).pairingRequest());
  }
  if (!page)
    return (
      <StartScreen
        busy={busy}
        actions={(["create", "join", "open"] as const).map((value) => ({
          title: value[0].toUpperCase() + value.slice(1),
          onSelect: () => void run(() => choose(value)),
        }))}
      />
    );
  return (
    <main className="min-h-dvh flex items-center justify-center px-6 py-12">
      {busy && progress && (
        <LoadingSpinner
          label={progress}
          className="fixed inset-0 z-40 min-h-dvh bg-background"
        />
      )}
      <div className="w-full max-w-xl space-y-8">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          disabled={busy}
          onClick={() => {
            setPage(undefined);
            setError("");
          }}
        >
          <ArrowLeft />
        </Button>
        <p className="text-muted-foreground">{descriptions[page]}</p>
        {page === "create" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && name.trim())
                void run(
                  async () => onOpen(await createLocalWorkspace(name.trim())),
                  "Creating workspace…",
                );
            }}
          >
            <label className="field-row">
              Workspace name
              <div className="flex">
                <Input
                  autoFocus
                  aria-label="Workspace name"
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  className="rounded-r-none"
                  required
                />
                <Button
                  type="submit"
                  aria-label="Create workspace"
                  disabled={busy || !name.trim()}
                  className="rounded-l-none"
                >
                  <ArrowRight />
                </Button>
              </div>
            </label>
          </form>
        )}
        {page === "join" && (
          <div className="space-y-6">
            {busy && !request && (
              <LoadingSpinner label="Preparing device request…" />
            )}
            <JoinWorkspaceForm
              request={request}
              disabled={busy}
              onJoin={(invitation, destination) =>
                run(
                  async () =>
                    onOpen(await joinWorkspace(invitation, destination)),
                  "Joining workspace…",
                )
              }
            />
            <Separator />
            <RepositoryConnectionSettings />
          </div>
        )}
        {page === "open" && (
          <div className="space-y-6">
            <WorkspacePicker
              profiles={saved}
              disabled={busy}
              loading={busy && !progress}
              onDeleted={(profile) =>
                setSaved((values) =>
                  values.filter((value) => value.id !== profile.id),
                )
              }
              onOpen={(profile) =>
                void run(
                  () => onOpen(profile),
                  `Opening ${profile.localName ?? profile.name}…`,
                )
              }
            />
            <Separator />
            <OpenWorkspaceFile
              onOpen={onOpen}
              disabled={busy}
              onBusyChange={(importing) => {
                setBusy(importing);
                setProgress(importing ? "Importing workspace…" : "");
                if (importing) setError("");
              }}
            />
          </div>
        )}
      </div>
    </main>
  );
}
