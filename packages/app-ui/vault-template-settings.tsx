import { useReportedError } from "./errors";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { VaultTemplate } from "./vault-shell";
import { Button } from "../ui/primitives/button";
import { Switch } from "../ui/primitives/switch";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "../ui/primitives/table";
export interface PluginFilePreferences {
  configuration?: Record<string, unknown>;
}
export function vaultTemplates(runtime: VaultRuntime): VaultTemplate[] {
  return [...runtime.vaults.values()].flatMap((vault) =>
    Object.values(vault.templates).flatMap((template) => {
      const file = vault.find(template.path);
      return file
        ? [
            {
              id: vault.id + "." + file.id,
              name: template.name,
              vault: vault.id,
              file: file.id,
              extension: "." + file.path.split(".").pop(),
              contentType: file.contentType,
              enabled: template.enabled,
            },
          ]
        : [];
    }),
  );
}
export async function updatePluginPreferences(
  runtime: VaultRuntime,
  id: string,
  patch: Partial<PluginFilePreferences>,
  target = "defaults",
) {
  await runtime.workspace.update((d) => {
    const destination =
      target === "defaults" ? d.defaults : d.computers[target];
    destination.plugins ??= {};
    destination.plugins[id] = {
      ...((destination.plugins[id] as object) ?? {}),
      ...patch,
    };
  });
}
export function VaultTemplateSettings({
  runtime,
  changed,
}: {
  runtime: VaultRuntime;
  changed(): void;
}) {
  const [, report] = useReportedError("templates");
  const run = (work: () => Promise<unknown>) => {
    void work().then(changed).catch(report);
  };
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Named paths</h2>
        <Button
          variant="outline"
          onClick={() =>
            void runtime.requestNamedPath("core", { key: "", kind: "folder" })
          }
        >
          Add named path
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Vault</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Kind</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...runtime.vaults.values()].flatMap((vault) =>
            Object.entries(vault.namedPaths).map(([key, value]) => (
              <TableRow key={vault.id + key}>
                <TableCell>{vault.name}</TableCell>
                <TableCell>{value.key}</TableCell>
                <TableCell>{value.path}</TableCell>
                <TableCell>{value.kind}</TableCell>
              </TableRow>
            )),
          )}
        </TableBody>
      </Table>
      <h2 className="font-medium">Templates</h2>
      <p className="text-sm text-muted-foreground">
        Register any file with “Use as template” in its menu. Templates belong
        to their vault and remain ordinary files.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Vault</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>File</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...runtime.vaults.values()].flatMap((vault) =>
            Object.values(vault.templates).map((template) => (
              <TableRow key={vault.id + template.path}>
                <TableCell>{vault.name}</TableCell>
                <TableCell>{template.name}</TableCell>
                <TableCell>{template.path}</TableCell>
                <TableCell>
                  <Switch
                    aria-label={`Enable template ${template.name}`}
                    checked={template.enabled}
                    onCheckedChange={(enabled) =>
                      run(() =>
                        vault.setTemplate(
                          template.path,
                          template.name,
                          enabled,
                        ),
                      )
                    }
                  />
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      run(() => vault.removeTemplate(template.path))
                    }
                  >
                    Unregister
                  </Button>
                </TableCell>
              </TableRow>
            )),
          )}
        </TableBody>
      </Table>
    </section>
  );
}
