import { WorkspaceIcon } from "./workspace-icon";
import { useState } from "react";
import { LoadingSpinner } from "../ui/loading-spinner";
import { ChevronDown, Trash2 } from "lucide-react";
import { Button } from "../ui/primitives/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/primitives/popover";
import { deleteSavedWorkspace, type WorkspaceProfile } from "./runtime";
import { DeleteWorkspaceDialog } from "./delete-workspace-dialog";

export function WorkspacePicker({
  profiles,
  disabled,
  loading = false,
  onOpen,
  onDeleted,
}: {
  profiles: WorkspaceProfile[];
  disabled: boolean;
  loading?: boolean;
  onOpen(profile: WorkspaceProfile): void;
  onDeleted(profile: WorkspaceProfile): void;
}) {
  const [open, setOpen] = useState(false),
    [deleting, setDeleting] = useState<WorkspaceProfile>();
  return (
    <div className="field-row">
      <span id="internal-workspaces-label">Saved workspaces</span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className="w-full justify-between font-normal"
            />
          }
          aria-labelledby="internal-workspaces-label"
          disabled={disabled || loading}
          aria-busy={loading}
        >
          <WorkspaceIcon />
          <span aria-live="polite" className="flex-1 text-left">
            {loading
              ? "Loading saved workspaces…"
              : profiles.length
                ? "Choose a workspace"
                : "No saved workspaces"}
          </span>
          <ChevronDown />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Saved workspaces"
          className="w-[var(--anchor-width)] max-h-80 overflow-y-auto"
        >
          {profiles.map((profile) => (
            <div key={profile.id} className="flex items-center gap-1">
              <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start font-normal"
                disabled={disabled || loading}
                onClick={() => {
                  setOpen(false);
                  onOpen(profile);
                }}
              >
                <WorkspaceIcon />
                <span className="truncate">
                  {profile.localName ?? profile.name}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                disabled={disabled || loading}
                aria-label={`Remove ${profile.localName ?? profile.name}`}
                title={`Remove ${profile.localName ?? profile.name}`}
                onClick={() => setDeleting(profile)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {!profiles.length &&
            (loading ? (
              <LoadingSpinner label="Loading saved workspaces…" />
            ) : (
              <p className="p-2 text-muted-foreground">No saved workspaces</p>
            ))}
        </PopoverContent>
        {deleting && (
          <DeleteWorkspaceDialog
            key={deleting.id}
            profile={deleting}
            onClose={() => setDeleting(undefined)}
            onDelete={async () => {
              await deleteSavedWorkspace(deleting);
              onDeleted(deleting);
            }}
          />
        )}
      </Popover>
    </div>
  );
}
