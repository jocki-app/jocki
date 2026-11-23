import { useReportedError } from "./errors";
import { useEffect, useState } from "react";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/primitives/dialog";
import { Input } from "../ui/primitives/input";
import { Button } from "../ui/primitives/button";
import { ChoiceSelect } from "../ui/choice-select";
export function VaultRequests({ runtime }: { runtime: VaultRuntime }) {
  const [, refresh] = useState(0),
    [vault, setVault] = useState(""),
    [key, setKey] = useState(""),
    [path, setPath] = useState(""),
    [destination, setDestination] = useState(""),
    [, setError] = useReportedError("vault-requests");
  useEffect(
    () => runtime.subscribeRequests(() => refresh((value) => value + 1)),
    [runtime],
  );
  const current = runtime.currentRequest;
  useEffect(() => {
    setVault(
      String(current?.request.vault ?? [...runtime.vaults.keys()][0] ?? ""),
    );
    setKey(String(current?.request.key ?? ""));
    setPath(String(current?.request.path ?? ""));
    setError("");
  }, [current]);
  const plugin = runtime.extensions
    .installed()
    .find((item) => item.manifest.id === current?.extension)?.manifest;
  const template = plugin?.contributes.templates.find(
    (item) => item.id === current?.request.template,
  );
  const destinations = Object.values(
    runtime.vaults.get(vault)?.namedPaths ?? {},
  ).filter((item) => item.key === "templates" && item.kind === "folder");
  return (
    <Dialog
      open={!!current}
      onOpenChange={(open) => {
        if (!open) runtime.finishRequest(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {current?.kind === "template"
              ? `Copy ${template?.title ?? "template"}?`
              : String(current?.request.title ?? "Add named path")}
          </DialogTitle>
          <DialogDescription>
            {current?.kind === "template"
              ? `${plugin?.name} offers a template file. Copy it into the templates named folder; it will belong to your vault.`
              : "Register a named file or folder in a vault. Plugins can request these paths through the shared interface."}
          </DialogDescription>
        </DialogHeader>
        <label>
          Vault
          <ChoiceSelect
            aria-label="Named path vault"
            value={vault}
            onValueChange={setVault}
            options={[...runtime.vaults.values()].map((vault) => ({
              value: vault.id,
              label: vault.name,
            }))}
          />
        </label>
        {current?.kind === "template" && destinations.length > 1 && (
          <label>
            Templates folder
            <ChoiceSelect
              aria-label="Templates destination"
              value={destination}
              onValueChange={setDestination}
              options={destinations.map((item) => ({
                value: item.id,
                label: item.path || "/",
              }))}
            />
          </label>
        )}
        {current?.kind === "path" && (
          <>
            <label>
              Key
              <Input
                aria-label="Named path key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
            <label>
              Path
              <Input
                aria-label="Named path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => runtime.finishRequest(false)}
          >
            Skip
          </Button>
          <Button
            disabled={
              !vault ||
              (current?.kind === "path" && (!key || !path)) ||
              (current?.kind === "template" &&
                destinations.length > 1 &&
                !destinations.some((item) => item.id === destination))
            }
            onClick={() => {
              void (
                current?.kind === "template"
                  ? runtime.copyTemplate(
                      current.extension,
                      String(current.request.template),
                      vault,
                      destination || undefined,
                    )
                  : runtime.addNamedPath({
                      vault,
                      key,
                      path,
                      kind:
                        current?.request.kind === "file" ? "file" : "folder",
                    })
              )
                .then(() => runtime.finishRequest(true))
                .catch((error) => setError(String(error)));
            }}
          >
            {current?.kind === "template" ? "Copy template" : "Add path"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
