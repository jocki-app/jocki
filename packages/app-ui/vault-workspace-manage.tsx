import { WorkspaceIcon } from "./workspace-icon";
import { useState } from "react";
import { ChevronDown, BrushCleaning, Trash2 } from "lucide-react";
import type { VaultLauncher } from "../platform-browser/vault-runtime";
import type { SavedWorkspace } from "../core/vaults/workspace-library";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Switch } from "../ui/primitives/switch";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/primitives/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/primitives/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import { notify } from "../ui/notifications";
export function WorkspaceManage({
  launcher,
  busy,
  onOpen,
}: {
  launcher: VaultLauncher;
  busy: boolean;
  onOpen(id: string): Promise<void>;
}) {
  const [selected, setSelected] = useState<SavedWorkspace>(),
    [open, setOpen] = useState(false),
    [, refresh] = useState(0),
    [plan, setPlan] =
      useState<Awaited<ReturnType<VaultLauncher["deletionPlan"]>>>(),
    [name, setName] = useState(""),
    [deleting, setDeleting] = useState(false),
    [workspace, setWorkspace] = useState(true),
    [vaults, setVaults] = useState<string[]>([]);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      refresh((n) => n + 1);
    } catch (error) {
      notify.error(error);
    }
  };
  return (
    <div className="space-y-4">
      <label className="block space-y-2 text-sm">Saved workspaces</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className="w-full justify-between font-normal"
            />
          }
          role="combobox"
          aria-label="Saved workspaces"
          disabled={busy || deleting}
        >
          <WorkspaceIcon />
          <span className="truncate">
            {selected
              ? selected.kind === "folder"
                ? selected.path
                : selected.name
              : "Choose a workspace"}
          </span>
          <ChevronDown />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--anchor-width)] max-h-80 overflow-y-auto"
          aria-label="Workspace list"
        >
          <div role="listbox" aria-label="Saved workspaces">
            {launcher.list().map((entry) => (
              <div key={entry.id} className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  role="option"
                  aria-selected={selected?.id === entry.id}
                  className="min-w-0 flex-1 justify-start font-normal"
                  onClick={() => {
                    setSelected(entry);
                    setOpen(false);
                  }}
                >
                  <WorkspaceIcon />
                  <span className="truncate" title={entry.path || entry.name}>
                    {entry.kind === "folder" ? entry.path : entry.name}
                  </span>
                </Button>
                {entry.kind === "folder" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Unlink ${entry.name}`}
                    title="Remove workspace reference"
                    onClick={() =>
                      void run(async () => {
                        await launcher.forget(entry.id);
                        if (selected?.id === entry.id) setSelected(undefined);
                      })
                    }
                  >
                    <BrushCleaning />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  aria-label={`Delete ${entry.name}`}
                  title="Delete workspace settings"
                  onClick={() =>
                    void run(async () => {
                      const next = await launcher.deletionPlan(entry.id);
                      setPlan(next);
                      setName("");
                      setWorkspace(true);
                      setVaults([]);
                      setOpen(false);
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {!launcher.list().length && (
              <p className="p-2 text-sm text-muted-foreground">
                No saved workspaces.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !selected}
          onClick={() => {
            if (selected) void onOpen(selected.id);
          }}
        >
          Open workspace
        </Button>
        {launcher.capabilities.workspaceFolder && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const chosen = await launcher.selectWorkspace(false);
                if (chosen)
                  await onOpen(await launcher.importWorkspace(chosen));
              })
            }
          >
            Open workspace file
          </Button>
        )}
      </div>
      <Dialog
        open={!!plan}
        onOpenChange={(value) => {
          if (!value && !deleting) setPlan(undefined);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delete workspace settings?</DialogTitle>
            <DialogDescription>
              Choose the settings to delete. Vault selections delete their
              binary .saddle companions, including metadata, history and
              share manifests. Ordinary files remain. A vault may also be
              referenced by another workspace.
            </DialogDescription>
          </DialogHeader>
          {plan && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (name !== plan.name || deleting) return;
                setDeleting(true);
                void run(async () => {
                  await launcher.delete(plan.entry.id, name, workspace, vaults);
                  if (workspace && selected?.id === plan.entry.id)
                    setSelected(undefined);
                  setPlan(undefined);
                }).finally(() => setDeleting(false));
              }}
            >
              <div className="max-h-72 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>Settings</TableHead>
                      <TableHead>Delete</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <WorkspaceIcon />
                          {plan.name}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-64 break-all">
                        {plan.entry.path || "Internal workspace JSON"}
                      </TableCell>
                      <TableCell>
                        <Switch
                          aria-label="Delete workspace JSON"
                          checked={workspace}
                          disabled={deleting}
                          onCheckedChange={setWorkspace}
                        />
                      </TableCell>
                    </TableRow>
                    {plan.vaults.map((vault) => (
                      <TableRow key={vault.id}>
                        <TableCell className="pl-6">{vault.name}</TableCell>
                        <TableCell>
                          Binary companions
                          {!vault.available && " (unavailable)"}
                        </TableCell>
                        <TableCell>
                          <Switch
                            aria-label={`Delete metadata for ${vault.name}`}
                            checked={vaults.includes(vault.id)}
                            disabled={deleting || !vault.available}
                            onCheckedChange={(checked) =>
                              setVaults((prior) =>
                                checked
                                  ? [...prior, vault.id]
                                  : prior.filter((id) => id !== vault.id),
                              )
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <label className="block space-y-2 text-sm">
                Type <strong>{plan.name}</strong> to confirm
                <Input
                  aria-label="Workspace name to confirm deletion"
                  value={name}
                  disabled={deleting}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={deleting}
                  onClick={() => setPlan(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={
                    deleting ||
                    name !== plan.name ||
                    (!workspace && !vaults.length)
                  }
                >
                  {deleting ? "Deleting…" : "Delete selected settings"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
