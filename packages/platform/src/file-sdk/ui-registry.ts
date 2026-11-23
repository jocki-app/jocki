/** Inert UI declarations shared by core and verified extensions. No declaration executes code. */
export const menuLocations = [
  "explorer/context",
  "explorer/open-with",
  "explorer/new-file",
  "explorer/add-data",
  "explorer/template",
  "explorer/template-copy",
  "explorer/template-link",
  "editor/title",
  "editor/toolbar",
  "toolbar",
  "settings",
  "workspace/context",
  "commandPalette",
] as const;
export type MenuLocation =
  | (typeof menuLocations)[number]
  | `csdb/import/${string}`
  | `csdb/templates/${string}`;
export type ResourceKind = "workspace" | "vault" | "folder" | "file";
export interface MenuContext {
  instance?: string;
  kind?: ResourceKind;
  vault?: string;
  id?: string;
  path?: string;
  mime?: string;
  contentType?: string | null;
  history?: boolean;
  sync?: boolean;
}
export interface MenuWhen {
  kinds?: ResourceKind[];
  mime?: string;
  contentType?: string;
  history?: boolean;
  sync?: boolean;
}
export interface MenuContribution {
  id: string;
  location: MenuLocation;
  title: string;
  command?: string;
  submenu?: MenuLocation;
  icon?: string;
  group?: string;
  order?: number;
  destructive?: boolean;
  disabled?: boolean;
  when?: MenuWhen;
  popover?: {
    title?: string;
    items: Array<{ command: string; title: string; icon?: string }>;
  };
}
export interface RegisteredMenu extends MenuContribution {
  owner: string;
}
export class UIContributionRegistry {
  private owners = new Map<string, MenuContribution[]>();
  replace(owner: string, entries: readonly MenuContribution[]) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.id.startsWith(owner + ".") || ids.has(entry.id))
        throw Error("Menu IDs must be unique and use their owner's namespace");
      if (Boolean(entry.command) === Boolean(entry.submenu))
        throw Error("A menu entry needs one command or submenu");
      ids.add(entry.id);
    }
    const registered = structuredClone(entries) as MenuContribution[];
    this.owners.set(owner, registered);
    return {
      dispose: () => {
        if (this.owners.get(owner) === registered) this.owners.delete(owner);
      },
    };
  }
  remove(owner: string) {
    this.owners.delete(owner);
  }
  items(location: MenuLocation, context: MenuContext = {}): RegisteredMenu[] {
    return [...this.owners]
      .flatMap(([owner, entries]) =>
        entries
          .filter(
            (e) => e.location === location && this.matches(e.when, context),
          )
          .map((e) => ({ ...e, owner })),
      )
      .sort(
        (a, b) =>
          (a.group ?? "").localeCompare(b.group ?? "") ||
          (a.order ?? 0) - (b.order ?? 0) ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
      );
  }
  private matches(when: MenuWhen | undefined, context: MenuContext) {
    return (
      !when ||
      ((!when.kinds || (!!context.kind && when.kinds.includes(context.kind))) &&
        (!when.mime || when.mime === context.mime) &&
        (!when.contentType || when.contentType === context.contentType) &&
        (when.history === undefined || when.history === context.history) &&
        (when.sync === undefined || when.sync === context.sync))
    );
  }
}
