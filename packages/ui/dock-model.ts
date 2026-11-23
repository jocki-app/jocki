export type DockView =
  | "page"
  | "edit"
  | "links"
  | "outline"
  | "properties"
  | "tags"
  | "history"
  | "sharing"
  | "columns"
  | "sql"
  | `plugin:${string}`;
export interface DockTab {
  file: string;
  view: DockView;
  instance?: string;
}
export interface DockPane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tabs: DockTab[];
  active: string;
}
export interface DockLayout {
  activePane?: string;
  panes: DockPane[];
}
export const dockKey = (tab: DockTab) =>
  tab.file + ":" + tab.view + (tab.instance ? "#" + tab.instance : "");
export function dropZone(x: number, y: number) {
  return [
    Math.min(2, Math.max(0, Math.floor(x * 3))),
    Math.min(2, Math.max(0, Math.floor(y * 3))),
  ] as const;
}
export function dropRect(zone: readonly number[]) {
  const [x, y] = zone;
  return {
    x: x === 2 ? 1 : 0,
    y: y === 2 ? 1 : 0,
    w: x === 1 ? 2 : 1,
    h: y === 1 ? 2 : 1,
  };
}
export function dockTab(
  layout: DockLayout,
  tab: DockTab,
  zone: readonly number[],
  target?: string,
  index?: number,
): DockLayout {
  const next: DockLayout = structuredClone(layout),
    key = dockKey(tab);
  for (const pane of next.panes)
    pane.tabs = pane.tabs.filter((t) => dockKey(t) !== key);
  if (zone[0] === 1 && zone[1] === 1) {
    let pane = next.panes.find((p) => p.id === target) ?? next.panes[0];
    if (!pane) {
      pane = {
        id: crypto.randomUUID(),
        x: 0,
        y: 0,
        w: 2,
        h: 2,
        tabs: [],
        active: key,
      };
      next.panes.push(pane);
    }
    pane.tabs.splice(index ?? pane.tabs.length, 0, tab);
    pane.active = key;
    next.activePane = pane.id;
  } else {
    const rect = dropRect(zone),
      displaced: DockTab[] = [];
    for (const pane of next.panes) {
      if (
        pane.x >= rect.x + rect.w ||
        pane.x + pane.w <= rect.x ||
        pane.y >= rect.y + rect.h ||
        pane.y + pane.h <= rect.y
      )
        continue;
      // Keep the largest rectangular remainder. Unused cells stay drop targets.
      const candidates = [
        { x: pane.x, y: pane.y, w: rect.x - pane.x, h: pane.h },
        {
          x: rect.x + rect.w,
          y: pane.y,
          w: pane.x + pane.w - rect.x - rect.w,
          h: pane.h,
        },
        { x: pane.x, y: pane.y, w: pane.w, h: rect.y - pane.y },
        {
          x: pane.x,
          y: rect.y + rect.h,
          w: pane.w,
          h: pane.y + pane.h - rect.y - rect.h,
        },
      ]
        .filter((r) => r.w > 0 && r.h > 0)
        .sort((a, b) => b.w * b.h - a.w * a.h);
      if (candidates[0]) Object.assign(pane, candidates[0]);
      else {
        displaced.push(...pane.tabs);
        pane.tabs = [];
      }
    }
    const id = crypto.randomUUID();
    next.activePane = id;
    next.panes.push({
      id,
      ...rect,
      tabs: [...displaced.filter((t) => dockKey(t) !== key), tab],
      active: key,
    });
  }
  next.panes = next.panes
    .filter((p) => p.tabs.length)
    .map((p) => ({
      ...p,
      active: p.tabs.some((t) => dockKey(t) === p.active)
        ? p.active
        : dockKey(p.tabs[0]),
    }));
  return next;
}
export function validDock(value: unknown): value is DockLayout {
  const views = [
    "page",
    "edit",
    "links",
    "outline",
    "properties",
    "tags",
    "history",
    "sharing",
    "columns",
    "sql",
  ];
  const v = value as DockLayout;
  return Boolean(
    v &&
    Array.isArray(v.panes) &&
    v.panes.length <= 20 &&
    v.panes.every(
      (p) =>
        typeof p.id === "string" &&
        [p.x, p.y, p.w, p.h].every(Number.isInteger) &&
        p.x >= 0 &&
        p.y >= 0 &&
        p.w > 0 &&
        p.h > 0 &&
        p.x + p.w <= 2 &&
        p.y + p.h <= 2 &&
        typeof p.active === "string" &&
        Array.isArray(p.tabs) &&
        p.tabs.length <= 100 &&
        p.tabs.every(
          (t) =>
            typeof t.file === "string" &&
            (views.includes(t.view) ||
              /^plugin:[a-z][a-z0-9.-]*$/.test(t.view)) &&
            (t.instance === undefined ||
              /^[a-zA-Z0-9_-]{1,128}$/.test(t.instance)),
        ),
    ),
  );
}
