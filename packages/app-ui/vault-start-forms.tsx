import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import type {
  VaultLauncher,
  VaultSelection,
  WorkspaceCreation,
} from "../platform-browser/vault-runtime";
import { notify } from "../ui/notifications";

export function StorageChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">
        {label}
        {options.length === 1 ? `: ${options[0].label}` : ""}
      </legend>
      {options.length > 1 && (
        <div className="flex flex-wrap gap-1 rounded-lg border p-1 w-fit">
          {options.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={value === option.value ? "secondary" : "ghost"}
              aria-pressed={value === option.value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </fieldset>
  );
}
export const emptyVault = (): VaultSelection => ({ kind: "none", name: "" });
export const emptyWorkspace = (): WorkspaceCreation => ({
  kind: "internal",
  name: "",
  vault: emptyVault(),
});
export function validVault(value?: VaultSelection) {
  return (
    !value ||
    value.kind === "none" ||
    (value.kind === "folder" ? !!value.selected : !!value.name.trim())
  );
}
export function validWorkspace(value: WorkspaceCreation) {
  return (
    (value.kind === "folder" ? !!value.selected : !!value.name.trim()) &&
    validVault(value.vault)
  );
}
export function VaultDestinationFields({
  launcher,
  value,
  onChange,
  allowNone = true,
  label = "Vault",
  disabled,
}: {
  launcher: VaultLauncher;
  value: VaultSelection;
  onChange(value: VaultSelection): void;
  allowNone?: boolean;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <StorageChoice
        label={label}
        value={value.kind}
        disabled={disabled}
        onChange={(kind) => onChange({ ...value, kind })}
        options={[
          ...(allowNone ? [{ value: "none" as const, label: "None" }] : []),
          ...(launcher.capabilities.vaultFolder
            ? [{ value: "folder" as const, label: "Folder" }]
            : []),
          { value: "internal", label: "Internal" },
        ]}
      />
      {value.kind === "internal" && (
        <label className="block space-y-2 text-sm">
          Vault name
          <Input
            aria-label={`${label} name`}
            value={value.name}
            disabled={disabled}
            required
            onChange={(event) =>
              onChange({ ...value, name: event.target.value })
            }
          />
        </label>
      )}
      {value.kind === "folder" && (
        <label className="block space-y-2 text-sm">
          Folder path
          <div className="flex gap-2">
            <Input
              aria-label={`${label} folder path`}
              readOnly
              value={value.selected?.path ?? ""}
              placeholder="Choose a folder"
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void launcher
                  .selectVault()
                  .then((selected) => {
                    if (selected)
                      onChange({ ...value, selected, name: selected.name });
                  })
                  .catch(notify.error)
              }
            >
              Browse
            </Button>
          </div>
        </label>
      )}
    </div>
  );
}
export function WorkspaceDestinationFields({
  launcher,
  value,
  onChange,
  disabled,
  showVault = true,
}: {
  launcher: VaultLauncher;
  value: WorkspaceCreation;
  onChange(value: WorkspaceCreation): void;
  disabled?: boolean;
  showVault?: boolean;
}) {
  return (
    <div className="space-y-5">
      <StorageChoice
        label="Workspace storage"
        value={value.kind}
        disabled={disabled}
        onChange={(kind) => onChange({ ...value, kind })}
        options={[
          ...(launcher.capabilities.workspaceFolder
            ? [{ value: "folder" as const, label: "Folder" }]
            : []),
          { value: "internal", label: "Internal" },
        ]}
      />
      {value.kind === "internal" ? (
        <label className="block space-y-2 text-sm">
          Workspace name
          <Input
            aria-label="Workspace name"
            value={value.name}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, name: event.target.value })
            }
            required
          />
        </label>
      ) : (
        <label className="block space-y-2 text-sm">
          Workspace JSON path
          <div className="flex gap-2">
            <Input
              aria-label="Workspace JSON path"
              readOnly
              value={value.selected?.path ?? ""}
              placeholder="Choose where to save the workspace"
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void launcher
                  .selectWorkspace(true)
                  .then((selected) => {
                    if (selected)
                      onChange({
                        ...value,
                        selected,
                        name: selected.name.replace(/\.json$/i, ""),
                      });
                  })
                  .catch(notify.error)
              }
            >
              Browse
            </Button>
          </div>
        </label>
      )}
      {showVault && (
        <VaultDestinationFields
          launcher={launcher}
          value={value.vault ?? emptyVault()}
          onChange={(vault) => onChange({ ...value, vault })}
          disabled={disabled}
        />
      )}
    </div>
  );
}
