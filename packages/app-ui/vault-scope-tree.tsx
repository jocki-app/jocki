import {
  useEffect,
  type CSSProperties,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  File,
  Folder,
  Ellipsis,
  CircleDashed,
  CircleMinus,
  CircleCheck,
} from "lucide-react";
import type { FileVault } from "../core/vaults/vault";
import type { VaultRuntime } from "../platform-browser/vault-runtime";
import { WorkspaceIcon } from "./workspace-icon";
import { Button } from "../ui/primitives/button";
import type { ShareSummary } from "../core/vaults/protected-sync";
import { useReportedError } from "./errors";
import {
  effectiveShareCounter,
  rollbackVersionCount,
  scopeColorRatio,
  scopeCountKey,
} from "./vault-scope-counts";
import {
  featureState,
  featureAncestors,
  type ScopeState,
  type ScopeTone,
  type FeatureTarget,
  type UnitFeature,
} from "./vault-feature-model";

export interface ScopeNode extends FeatureTarget {
  key: string;
  name: string;
  parent: string;
  depth: number;
  state: ScopeState;
  tone: ScopeTone;
  deleted?: boolean;
}
const settingNames = {
  enabled: "Enabled",
  disabled: "Disabled",
  unset: "Unset",
};
const settingIcons = {
  enabled: CircleCheck,
  disabled: CircleMinus,
  unset: CircleDashed,
};
const setting = (state: ScopeState) =>
  state === "enabled" || state === "disabled" ? state : "unset";
type Quantities = {
  counts: Map<string, number>;
  maximum: number;
  pending: boolean;
};
const quantityStyle = (count: number | undefined, maximum: number) =>
  ({ "--scope-ratio": scopeColorRatio(count ?? 0, maximum) }) as CSSProperties;

function SettingIcon({
  state,
  decorative = false,
}: {
  state: keyof typeof settingNames;
  decorative?: boolean;
}) {
  const Icon = settingIcons[state];
  return (
    <Icon
      className="size-3.5 shrink-0"
      strokeWidth={2.5}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : settingNames[state]}
      aria-hidden={decorative || undefined}
      data-scope-setting={state}
    />
  );
}

function CountLegend({
  quantities,
  feature,
}: {
  quantities: Quantities;
  feature: UnitFeature;
}) {
  const { maximum, pending } = quantities;
  const ticks = [
    ...new Set([
      0,
      ...(maximum > 0 ? [1, Math.ceil(maximum / 2), maximum] : []),
    ]),
  ].sort((a, b) => a - b);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
      aria-label="Hierarchy legend"
    >
      <span>
        {feature === "history" ? "Rollback versions" : "Effective shares"}
      </span>
      {pending ? (
        <span role="status">Counting…</span>
      ) : (
        ticks.map((count) => (
          <span key={count} className="flex items-center gap-1">
            <span
              className="vault-scope-color size-2.5 rounded-sm border border-current/30"
              data-scope-count={count}
              style={quantityStyle(count, maximum)}
            />
            {count}
          </span>
        ))
      )}
      <span className="ml-auto flex flex-wrap gap-x-3 gap-y-1">
        {(Object.keys(settingNames) as (keyof typeof settingNames)[]).map(
          (state) => (
            <span key={state} className="flex items-center gap-1">
              <SettingIcon state={state} decorative />
              {settingNames[state]}
            </span>
          ),
        )}
      </span>
    </div>
  );
}
/** Index every descendant without loading file contents or histories. */
function scopeLayers(
  runtime: VaultRuntime,
  vault: FileVault,
  path: string,
  feature: UnitFeature,
  id?: string,
): ScopeNode[][] {
  const root: FeatureTarget = { vault, path, id };
  const layers: ScopeNode[][] = [
    [
      {
        ...root,
        key: id ?? path,
        name: path.split("/").pop() || vault.name,
        parent: "",
        depth: 0,
        ...featureState(runtime, root, feature),
      },
    ],
  ];
  if (id) return layers;
  const add = (target: FeatureTarget, deleted = false) => {
    const location = target.path!;
    if (path && !location.startsWith(path + "/")) return;
    const relative = path ? location.slice(path.length + 1) : location;
    const depth = relative.split("/").length;
    const node: ScopeNode = {
      ...target,
      key: target.id ?? location,
      name: location.split("/").pop()!,
      parent: location.includes("/")
        ? location.slice(0, location.lastIndexOf("/"))
        : "",
      depth,
      ...featureState(runtime, target, feature),
      deleted,
    };
    (layers[depth] ??= []).push(node);
  };
  const folders = new Set(vault.directories());
  const files =
    feature === "history"
      ? [...vault.list(), ...vault.deletedFiles()]
      : vault.list();
  // Deleted files can outlive their former folders; retain their parent chain in the diagram.
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    while (parts.length) {
      const parent = parts.join("/");
      if (folders.has(parent)) break;
      folders.add(parent);
      parts.pop();
    }
  }
  for (const folder of folders) add({ vault, path: folder });
  for (const file of files)
    add({ vault, path: file.path, id: file.id }, file.deleted);
  for (const layer of layers)
    layer?.sort(
      (a, b) =>
        a.parent.localeCompare(b.parent) ||
        Number(!!a.id) - Number(!!b.id) ||
        a.name.localeCompare(b.name),
    );
  return layers.filter(Boolean);
}
interface ScopeBranch extends ScopeNode {
  children: ScopeBranch[];
  span: number;
  height: number;
}
/** A parent's horizontal span is the sum of its leaf columns. */
function branch(
  runtime: VaultRuntime,
  vault: FileVault,
  path: string,
  feature: UnitFeature,
  id?: string,
): ScopeBranch {
  const nodes = scopeLayers(runtime, vault, path, feature, id)
    .flat()
    .map((node) => ({
      ...node,
      children: [] as ScopeBranch[],
      span: 1,
      height: 0,
    }));
  const root = nodes[0];
  const folders = new Map(
    nodes.filter((node) => !node.id).map((node) => [node.path ?? "", node]),
  );
  for (const node of nodes.slice(1))
    folders.get(node.parent)!.children.push(node);
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    node.span = Math.max(
      1,
      node.children.reduce((sum, child) => sum + child.span, 0),
    );
    node.height = node.children.reduce(
      (height, child) => Math.max(height, child.height + 1),
      0,
    );
  }
  return root;
}
function Branch({
  node,
  level = 0,
  onOpen,
  current = false,
  bottomLeft,
  bottomRight,
  quantities,
  feature,
}: {
  node: ScopeBranch;
  quantities: Quantities;
  feature: UnitFeature;
  bottomLeft?: ScopeBranch;
  bottomRight?: ScopeBranch;
  current?: boolean;
  level?: number;
  onOpen(target: FeatureTarget): void;
}) {
  const count = quantities.counts.get(scopeCountKey(node));
  const status = settingNames[setting(node.state)];
  const description = `${node.path || node.name}: ${status}, ${count === undefined ? (quantities.pending ? "counting" : "count unavailable") : `${count} ${feature === "history" ? "rollback versions" : "effective shares"}`}${node.deleted ? ", deleted" : ""}`;
  return (
    <div
      className="flex min-w-0 flex-col"
      style={{ flex: `${node.span} 1 0%` }}
    >
      <div data-scope-layer={level}>
        <button
          type="button"
          data-scope-path={node.vault ? (node.path ?? "") : undefined}
          data-scope-current={current || undefined}
          data-scope-bottom-left={node === bottomLeft || undefined}
          data-scope-bottom-right={node === bottomRight || undefined}
          aria-current={current ? "true" : undefined}
          data-scope-state={node.state}
          data-scope-tone={node.tone}
          data-scope-unit={
            node.vault ? (node.id ? "file" : "folder") : "workspace"
          }
          data-scope-count={count}
          style={quantityStyle(count, quantities.maximum)}
          aria-label={description}
          title={description}
          className="vault-scope-color vault-scope-cell flex h-10 w-full min-w-0 items-center gap-2 rounded-none border-0 px-3 text-left text-xs transition-colors focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring"
          onClick={() => onOpen(node)}
        >
          {!node.vault ? (
            <WorkspaceIcon
              className="size-3.5 shrink-0"
              strokeWidth={current ? 3 : 2}
            />
          ) : node.id ? (
            <File className="size-3.5 shrink-0" strokeWidth={current ? 3 : 2} />
          ) : (
            <Folder
              className="size-3.5 shrink-0"
              strokeWidth={current ? 3 : 2}
            />
          )}
          <span
            className={`vault-scope-label min-w-0 truncate font-normal ${node.deleted ? "line-through" : ""}`}
          >
            {node.name}
          </span>
          <SettingIcon state={setting(node.state)} />
          {current && (
            <span className="shrink-0 bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium">
              Current
            </span>
          )}
        </button>
      </div>
      {node.children.length > 0 && (
        <div
          className="flex items-start"
          data-scope-children={node.path ?? node.name}
        >
          {node.children.map((child) => (
            <Branch
              key={child.key}
              node={child}
              quantities={quantities}
              feature={feature}
              level={level + 1}
              bottomLeft={bottomLeft}
              bottomRight={bottomRight}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function visibleBranch(node: ScopeBranch, depth: number): ScopeBranch {
  const children =
    depth > 0
      ? node.children.map((child) => visibleBranch(child, depth - 1))
      : [];
  return {
    ...node,
    children,
    height: children.reduce(
      (height, child) => Math.max(height, child.height + 1),
      0,
    ),
    span: Math.max(
      1,
      children.reduce((sum, child) => sum + child.span, 0),
    ),
  };
}
/** Round the first and last cells of the deepest visible row, including uneven branches. */
function bottomEdge(node: ScopeBranch, side: "left" | "right"): ScopeBranch {
  while (node.height) {
    const children = node.children.filter(
      (child) => child.height === node.height - 1,
    );
    node = children[side === "left" ? 0 : children.length - 1];
  }
  return node;
}
const noShares: readonly ShareSummary[] = [];
interface CountSource {
  runtime: VaultRuntime;
  feature: UnitFeature;
  shares?: readonly ShareSummary[];
  broadcast?: boolean;
}
function useQuantities(
  root: ScopeBranch,
  ancestors: ScopeBranch[],
  { runtime, feature, shares = noShares, broadcast = false }: CountSource,
): Quantities {
  const [, report] = useReportedError("hierarchy-counts");
  const nodes = useMemo(() => {
    const result: ScopeBranch[] = [...ancestors],
      queue = [root];
    while (queue.length) {
      const node = queue.pop()!;
      result.push(node);
      for (const child of node.children) queue.push(child);
    }
    return result;
  }, [root, ancestors]);
  const [snapshot, setSnapshot] = useState<{
    nodes: ScopeBranch[];
    counts: Map<string, number>;
  }>();
  useEffect(() => {
    if (feature !== "history") return;
    let cancelled = false,
      next = 0;
    const counts = new Map<string, number>();
    const worker = async () => {
      while (!cancelled && next < nodes.length) {
        const node = nodes[next++];
        const count = await rollbackVersionCount(runtime, node);
        if (cancelled) return;
        counts.set(scopeCountKey(node), count);
      }
    };
    void Promise.all(Array.from({ length: Math.min(8, nodes.length) }, worker))
      .then(() => {
        if (!cancelled) setSnapshot({ nodes, counts });
      })
      .catch((error) => {
        if (!cancelled) {
          cancelled = true;
          report(error);
          setSnapshot({ nodes, counts });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nodes, runtime, feature, report]);
  return useMemo(() => {
    const countShares = effectiveShareCounter(runtime, shares, broadcast);
    const counts =
      feature === "sync"
        ? new Map(nodes.map((node) => [scopeCountKey(node), countShares(node)]))
        : snapshot?.nodes === nodes
          ? snapshot.counts
          : new Map<string, number>();
    let maximum = 0;
    for (const count of counts.values()) maximum = Math.max(maximum, count);
    return {
      counts,
      maximum,
      pending: feature === "history" && snapshot?.nodes !== nodes,
    };
  }, [runtime, shares, broadcast, feature, nodes, snapshot]);
}
function Cake({
  root,
  onOpen,
  ancestors = noAncestors,
  ...source
}: CountSource & {
  root: ScopeBranch;
  ancestors?: ScopeBranch[];
  onOpen(target: FeatureTarget): void;
}) {
  const quantities = useQuantities(root, ancestors, source);
  const [depth, setDepth] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => visibleBranch(root, depth), [root, depth]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [depth, ancestors.length]);
  return (
    <div
      className="space-y-2"
      aria-busy={quantities.pending}
      data-scope-quantities
    >
      <CountLegend quantities={quantities} feature={source.feature} />
      <div
        ref={scroll}
        className="max-h-[min(40dvh,24rem)] overflow-auto"
        data-scope-cake
        role="region"
        aria-label="Folder and file hierarchy"
        tabIndex={0}
      >
        <div
          className="overflow-hidden rounded-t-lg"
          data-scope-cells
          style={{ minWidth: visible.span * 88 }}
        >
          {ancestors.map((node, index) => (
            <div key={node.key} data-scope-context>
              <Branch
                node={node}
                quantities={quantities}
                feature={source.feature}
                level={index - ancestors.length}
                onOpen={onOpen}
              />
            </div>
          ))}
          <Branch
            node={visible}
            quantities={quantities}
            feature={source.feature}
            current
            onOpen={onOpen}
            bottomLeft={bottomEdge(visible, "left")}
            bottomRight={bottomEdge(visible, "right")}
          />
        </div>
        {depth < root.height && (
          <div
            className="sticky left-0 flex h-10 w-full items-center justify-center"
            data-scope-more
          >
            <Button
              className="h-10 w-full"
              variant="ghost"
              aria-label="Load next level"
              title="Load next level"
              onClick={() => setDepth(depth + 1)}
            >
              <Ellipsis />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
const noAncestors: ScopeBranch[] = [];
function VaultTree({
  runtime,
  vault,
  path = "",
  id,
  feature,
  onOpen,
  shares,
  broadcast,
}: FeatureTarget &
  CountSource & {
    vault: FileVault;
    onOpen(target: FeatureTarget): void;
  }) {
  const version = useSyncExternalStore(
    (listener) => vault.subscribe(listener),
    () => vault.version,
  );
  const workspace = useSyncExternalStore(
    (listener) => runtime.workspace.subscribe(listener),
    () => runtime.workspace.current,
  );
  const root = useMemo(
    () => branch(runtime, vault, path, feature, id),
    [runtime, vault, path, feature, id, version, workspace.features[feature]],
  );
  const workspaceVersions =
    feature === "history" ? runtime.workspace.historyVersionCount() : 0;
  const ancestors = useMemo(
    () =>
      featureAncestors({ vault, path, id }).map((target, index) => ({
        ...target,
        key: target.vault ? `${target.vault.id}:${target.path}` : "workspace",
        name: target.vault
          ? target.path?.split("/").pop() || target.vault.name
          : runtime.workspace.current.name,
        parent: "",
        depth: index,
        ...featureState(runtime, target, feature),
        children: [],
        span: 1,
        height: 0,
      })),
    [
      runtime,
      vault,
      path,
      id,
      feature,
      version,
      workspace.features[feature],
      workspace.name,
      workspaceVersions,
    ],
  );
  return (
    <Cake
      key={`${path}:${id ?? ""}`}
      root={root}
      runtime={runtime}
      feature={feature}
      shares={shares}
      broadcast={broadcast}
      ancestors={ancestors}
      onOpen={onOpen}
    />
  );
}
function WorkspaceTree({
  runtime,
  feature,
  onOpen,
  shares,
  broadcast,
}: CountSource & {
  onOpen(target: FeatureTarget): void;
}) {
  const version = useSyncExternalStore(
    (listener) => {
      const remove = [
        runtime.workspace.subscribe(listener),
        ...[...runtime.vaults.values()].map((vault) =>
          vault.subscribe(listener),
        ),
      ];
      return () => remove.forEach((unsubscribe) => unsubscribe());
    },
    () =>
      [...runtime.vaults.values()]
        .map((vault) => `${vault.id}:${vault.version}`)
        .join("|") +
      JSON.stringify([
        runtime.workspace.current.name,
        runtime.workspace.current.features,
        feature === "history" ? runtime.workspace.historyVersionCount() : 0,
      ]),
  );
  const root = useMemo(() => {
    const children = [...runtime.vaults.values()].map((vault) => ({
      ...branch(runtime, vault, "", feature),
      key: vault.id,
    }));
    return {
      key: "workspace",
      name: runtime.workspace.current.name,
      parent: "",
      depth: 0,
      ...featureState(runtime, {}, feature),
      children,
      span: Math.max(
        1,
        children.reduce((sum, child) => sum + child.span, 0),
      ),
      height: children.reduce(
        (height, child) => Math.max(height, child.height + 1),
        0,
      ),
    };
  }, [runtime, feature, version]);
  return (
    <Cake
      root={root}
      onOpen={onOpen}
      runtime={runtime}
      feature={feature}
      shares={shares}
      broadcast={broadcast}
    />
  );
}
export function ScopeTree({
  runtime,
  feature,
  onOpen,
  shares,
  broadcast,
  ...target
}: FeatureTarget &
  CountSource & {
    onOpen(target: FeatureTarget): void;
  }) {
  return (
    <section
      className="min-h-0 min-w-0 shrink-0 space-y-2"
      aria-label={`${feature === "history" ? "History" : "Sharing"} inheritance`}
      data-scope-tree={feature}
    >
      {target.vault ? (
        <VaultTree
          {...target}
          vault={target.vault}
          runtime={runtime}
          feature={feature}
          onOpen={onOpen}
          shares={shares}
          broadcast={broadcast}
        />
      ) : (
        <WorkspaceTree
          runtime={runtime}
          feature={feature}
          onOpen={onOpen}
          shares={shares}
          broadcast={broadcast}
        />
      )}
    </section>
  );
}
