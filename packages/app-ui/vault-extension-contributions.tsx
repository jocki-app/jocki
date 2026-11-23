import { useReportedError } from "./errors";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/primitives/collapsible";
import { CheckboxInput } from "./vault-shell";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { useEffect, useState } from "react";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import type { TreeItem } from "../platform/src/file-sdk";

export function ExtensionViews({
  runtime,
  location,
  revision,
  report,
  selected,
}: {
  runtime: VaultRuntime;
  location: "sidebar" | "panel" | "navigation";
  selected?: string;
  revision: number;
  report(error: unknown): void;
}) {
  return (
    <>
      {runtime.extensions
        .viewContributions()
        .filter(
          (view) =>
            view.location === location && (!selected || view.id === selected),
        )
        .map((view) => (
          <ExtensionTree
            key={view.id}
            runtime={runtime}
            id={view.id}
            title={view.title}
            revision={revision}
            report={report}
            initiallyOpen={location === "navigation"}
          />
        ))}
    </>
  );
}
function ExtensionTree({
  runtime,
  id,
  title,
  revision,
  report,
  initiallyOpen = false,
}: {
  runtime: VaultRuntime;
  initiallyOpen?: boolean;
  id: string;
  title: string;
  revision: number;
  report(error: unknown): void;
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [items, setItems] = useState<TreeItem[]>([]),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    void runtime.extensions
      .treeItems(id)
      .then((items) => {
        if (!disposed) setItems(items);
      })
      .catch((error) => {
        if (!disposed) report(error);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [open, revision, id]);
  const tree = (items: TreeItem[], depth = 0): React.ReactNode =>
    depth > 20 ? null : (
      <ul>
        {items.slice(0, 1000).map((item) => (
          <li key={item.id}>
            {item.children ? (
              <Collapsible>
                <CollapsibleTrigger render={<Button variant="ghost" />}>
                  {item.label}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {tree(item.children, depth + 1)}
                </CollapsibleContent>
              </Collapsible>
            ) : item.command ? (
              <Button
                variant="outline"
                title={item.description}
                onClick={() => {
                  void runtime.extensions
                    .executeCommand(item.command!)
                    .catch(report);
                }}
              >
                {item.label}
              </Button>
            ) : (
              <span title={item.description}>{item.label}</span>
            )}
          </li>
        ))}
      </ul>
    );
  return (
    <Collapsible
      className="vault-extension-view"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger render={<Button variant="ghost" />}>
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {loading ? <p role="status">Loading…</p> : tree(items)}
      </CollapsibleContent>{" "}
    </Collapsible>
  );
}

export function ExtensionConfiguration({
  runtime,
  target,
  changed,
  extension,
}: {
  runtime: VaultRuntime;
  target: string;
  changed(): void;
  extension?: string;
}) {
  const [error, setError] = useReportedError("vault-extension-contributions");
  const save = async (extension: string, key: string, value: unknown) => {
    try {
      await runtime.workspace.update((d) => {
        const settings =
          target === "defaults" ? d.defaults : d.computers[target];
        settings.plugins ??= {};
        settings.plugins[extension] ??= {};
        const section = settings.plugins[extension] as {
          configuration?: Record<string, unknown>;
        };
        section.configuration ??= {};
        section.configuration[key] = value;
      });
      setError("");
      changed();
    } catch (error) {
      setError(error);
    }
  };
  return (
    <section>
      <h2>Extension settings</h2>
      {runtime.extensions
        .configurationContributions()
        .filter((s) => !extension || s.extension === extension)
        .map((setting) => {
          const settings =
            target === "defaults"
              ? runtime.workspace.current.defaults
              : runtime.workspace.current.computers[target];
          const section = settings?.plugins?.[setting.extension] as
            { configuration?: Record<string, unknown> } | null | undefined;
          const raw = section?.configuration?.[setting.key],
            inherited = raw == null;
          const defaults = runtime.workspace.current.defaults.plugins[
            setting.extension
          ] as { configuration?: Record<string, unknown> } | undefined;
          const value =
            raw ?? defaults?.configuration?.[setting.key] ?? setting.default;
          return (
            <div className="vault-extension-setting" key={target + setting.key}>
              <label>
                {setting.title}
                {setting.type === "boolean" ? (
                  <CheckboxInput
                    aria-label={setting.title}
                    type="checkbox"
                    checked={value === true}
                    onChange={(e) =>
                      void save(
                        setting.extension,
                        setting.key,
                        e.target.checked,
                      )
                    }
                  />
                ) : (
                  <Input
                    aria-label={setting.title}
                    key={JSON.stringify(value)}
                    defaultValue={
                      typeof value === "string" ? value : JSON.stringify(value)
                    }
                    onBlur={(e) => {
                      try {
                        const parsed =
                          setting.type === "string"
                            ? e.target.value
                            : JSON.parse(e.target.value);
                        if (
                          (setting.type === "array"
                            ? !Array.isArray(parsed)
                            : typeof parsed !== setting.type) ||
                          parsed == null
                        )
                          throw Error("Invalid " + setting.type + " setting");
                        void save(setting.extension, setting.key, parsed);
                      } catch (error) {
                        setError(error);
                      }
                    }}
                  />
                )}
              </label>
              {target !== "defaults" && (
                <Button
                  variant="outline"
                  disabled={inherited}
                  onClick={() =>
                    void save(setting.extension, setting.key, null)
                  }
                >
                  {inherited ? "Using default" : "Use default"}
                </Button>
              )}
            </div>
          );
        })}
    </section>
  );
}
