import { useState, useSyncExternalStore } from "react";
import { Info } from "lucide-react";
import { Tooltip } from "@base-ui/react/tooltip";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import { Button } from "../ui/primitives/button";
import { useReportedError } from "./errors";

import {
  featureOverride,
  type FeatureTarget,
  type UnitFeature,
} from "./vault-feature-model";

/** An absent value is persisted by deleting the override, never by writing false. */
export function FeatureControl({
  runtime,
  feature,
  ...target
}: FeatureTarget & {
  runtime: VaultRuntime;
  feature: UnitFeature;
}) {
  useSyncExternalStore(
    (listener) =>
      target.vault?.subscribe(listener) ??
      runtime.workspace.subscribe(listener),
    () => target.vault?.version ?? runtime.workspace.current,
  );
  const [busy, setBusy] = useState(false);
  const [, report] = useReportedError("feature-setting");
  const value = target.vault
    ? featureOverride(target, feature)
    : runtime.workspace.current.features[feature];
  const name = feature === "sync" ? "Sharing" : "History";
  const selected =
    value === undefined ? "Unset" : value ? "Enabled" : "Disabled";
  return (
    <div
      className="flex w-fit shrink-0 rounded-lg border bg-muted/40 p-0.5"
      role="group"
      aria-label={`${name} setting`}
    >
      {(["Unset", "Disabled", "Enabled"] as const).map((label) => (
        <Button
          key={label}
          variant={selected === label ? "secondary" : "ghost"}
          className={selected === label ? "bg-background shadow-sm" : undefined}
          size="sm"
          aria-pressed={selected === label}
          disabled={busy}
          title={
            label === "Unset"
              ? "Inherit from the enclosing folder or workspace"
              : `${label} on this item`
          }
          onClick={() => {
            if (selected === label) return;
            setBusy(true);
            const policy = {
              [feature]: label === "Unset" ? undefined : label === "Enabled",
            };
            const work = target.vault
              ? runtime.configureScope(
                  target.vault,
                  target.id ? "file" : target.path ? "folder" : "vault",
                  target.id ?? target.path ?? "",
                  policy,
                )
              : runtime.configureWorkspace(policy);
            void work.catch(report).finally(() => setBusy(false));
          }}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

export function FeatureInfo({ feature }: { feature: UnitFeature }) {
  const name = feature === "history" ? "history" : "sharing";
  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`About ${name}`}
            />
          }
        >
          <Info className="size-4 text-muted-foreground" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner
            side="bottom"
            align="start"
            sideOffset={6}
            className="z-[100]"
          >
            <Tooltip.Popup
              role="tooltip"
              className="max-w-80 rounded-lg border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-md"
            >
              Unset inherits the nearest folder or workspace setting. Disabled
              blocks {name} here and on descendants that inherit it.
              {feature === "sync"
                ? " Enabled allows adding direct shares while keeping inherited access."
                : " Enabled retains versions here."}
              {feature === "history"
                ? " Disabling history hides rollback versions immediately. Unshared archives are cleaned immediately; shared archives wait for every participating computer to agree. A child can explicitly enable its own history. Restoring a version creates a draft."
                : " Broadcast switches pause or resume individual shares; the header switch pauses this app. Parent access includes enabled descendants, and child shares can add access. Disconnecting keeps saved files on every computer. Shared documents include their retained history."}
              <span className="mt-2 block">
                {feature === "history"
                  ? "Green intensity shows how many versions each item can be rolled back to."
                  : "Green intensity shows how many share rows cover each item with Broadcast on. Paused or disabled sharing counts as zero."}{" "}
                The scale spans the whole hierarchy, including hidden levels.
                Icons beside names show Unset, Disabled or Enabled. Disabled is
                red; inherited Disabled uses lighter red. Other zero counts are
                grey.
              </span>
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
