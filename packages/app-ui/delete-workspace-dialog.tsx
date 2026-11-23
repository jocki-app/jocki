import { notify } from "../ui/notifications";
import { useState } from "react";
import { Input } from "../ui/primitives/input";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "../ui/primitives/alert-dialog";
import type { WorkspaceProfile } from "./runtime";

/** Both workspace entry points use the same explicit, exact-name confirmation. */
export function DeleteWorkspaceDialog({
  profile,
  onClose,
  onDelete,
}: {
  profile: WorkspaceProfile;
  onClose(): void;
  onDelete(): Promise<void>;
}) {
  const savedName = profile.localName ?? profile.name;
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false);
  async function remove() {
    if (busy || name !== savedName) return;
    setBusy(true);

    try {
      await onDelete();
      notify.success("Workspace removed from the saved list.");
      onClose();
    } catch (error) {
      notify.error(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            Remove this workspace from the saved list and clear its local query
            cache. Repository history, identity keys and exported bundles
            remain.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void remove();
          }}
        >
          <div className="field-row">
            <p>
              Type <strong className="select-all break-all">{savedName}</strong>{" "}
              to confirm.
            </p>
            <Input
              aria-label="Workspace name to confirm removal"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              variant="destructive"
              disabled={busy || name !== savedName}
            >
              {busy ? "Removing…" : "Remove workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
