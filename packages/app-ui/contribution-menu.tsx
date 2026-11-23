import { Fragment, type ReactElement } from "react";
import { WorkspaceIcon } from "./workspace-icon";
import {
  FilePlus2,
  FolderPlus,
  Upload,
  Pencil,
  Trash2,
  Share2,
  History,
  BookTemplate,
  Copy,
  Link2,
  Settings,
  Puzzle,
  Keyboard,
  ScrollText,
  Network,
  Library,
  FileText,
  MoreHorizontal,
  Code2,
  ExternalLink,
  Star,
  Pin,
  Search,
  FilePenLine,
  ListTree,
  Tags,
  ListFilter,
  Columns3,
  Table2,
  ListTodo,
  Folder,
} from "lucide-react";
import * as Dropdown from "../ui/primitives/dropdown-menu";
import * as Context from "../ui/primitives/context-menu";
import { Button } from "../ui/primitives/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/primitives/popover";
import type {
  MenuContext,
  MenuLocation,
  RegisteredMenu,
} from "../platform/src/file-sdk/ui-registry";

export interface MenuEntry extends RegisteredMenu {
  children?: MenuEntry[];
}
export interface MenuBindings {
  items(location: MenuLocation, context: MenuContext): MenuEntry[];
  execute(item: RegisteredMenu, context: MenuContext): void;
}
export function ToolbarContribution({
  item,
  context,
  bindings,
}: {
  item: MenuEntry;
  context: MenuContext;
  bindings: MenuBindings;
}) {
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={item.title}
      title={item.title}
      disabled={item.disabled}
      onClick={item.popover ? undefined : () => bindings.execute(item, context)}
    >
      <ContributionIcon name={item.icon} />
    </Button>
  );
  return item.popover ? (
    <Popover>
      <PopoverTrigger render={button} />
      <PopoverContent
        className="w-64 p-2"
        aria-label={item.popover.title ?? item.title}
      >
        {item.popover.title && (
          <p className="p-2 text-sm font-medium">{item.popover.title}</p>
        )}
        {item.popover.items.map((action) => (
          <Button
            key={action.command}
            variant="ghost"
            className="w-full justify-start"
            onClick={() =>
              bindings.execute(
                { ...item, command: action.command, title: action.title },
                context,
              )
            }
          >
            <ContributionIcon name={action.icon} />
            {action.title}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  ) : (
    button
  );
}
const icons: Record<string, typeof Settings> = {
  FilePlus2,
  FolderPlus,
  Upload,
  Pencil,
  Trash2,
  Share2,
  History,
  BookTemplate,
  Copy,
  Link2,
  Settings,
  Puzzle,
  Keyboard,
  ScrollText,
  Network,
  Library,
  FileText,
  MoreHorizontal,
  Code2,
  ExternalLink,
  Star,
  Pin,
  Search,
  FilePenLine,
  ListTree,
  Tags,
  ListFilter,
  Columns3,
  Table2,
  ListTodo,
  Folder,
};
export function ContributionIcon({ name }: { name?: string }) {
  if (name === "Workspace") return <WorkspaceIcon />;
  const Icon = icons[name ?? ""] ?? Puzzle;
  return <Icon className="size-4 shrink-0" />;
}
export function ContributionItems({
  bindings,
  location,
  context,
  contextMenu = false,
  depth = 0,
  items,
}: {
  bindings: MenuBindings;
  location: MenuLocation;
  context: MenuContext;
  contextMenu?: boolean;
  depth?: number;
  items?: MenuEntry[];
}) {
  const entries = items ?? bindings.items(location, context);
  const Item = contextMenu
    ? Context.ContextMenuItem
    : Dropdown.DropdownMenuItem;
  const Separator = contextMenu
    ? Context.ContextMenuSeparator
    : Dropdown.DropdownMenuSeparator;
  const Sub = contextMenu ? Context.ContextMenuSub : Dropdown.DropdownMenuSub;
  const SubTrigger = contextMenu
    ? Context.ContextMenuSubTrigger
    : Dropdown.DropdownMenuSubTrigger;
  const SubContent = contextMenu
    ? Context.ContextMenuSubContent
    : Dropdown.DropdownMenuSubContent;
  if (depth > 4) return null;
  return (
    <>
      {entries.map((entry, index) => (
        <Fragment key={entry.id}>
          {index > 0 && entries[index - 1].group !== entry.group && (
            <Separator />
          )}
          {entry.submenu || entry.children ? (
            <Sub>
              <SubTrigger disabled={entry.disabled} data-menu-id={entry.id}>
                <ContributionIcon name={entry.icon} />
                {entry.title}
              </SubTrigger>
              <SubContent>
                <ContributionItems
                  bindings={bindings}
                  location={entry.submenu ?? location}
                  items={entry.children}
                  context={context}
                  contextMenu={contextMenu}
                  depth={depth + 1}
                />
              </SubContent>
            </Sub>
          ) : (
            <Item
              data-menu-id={entry.id}
              data-command={entry.command}
              disabled={entry.disabled}
              variant={entry.destructive ? "destructive" : "default"}
              onClick={() => bindings.execute(entry, context)}
            >
              <ContributionIcon name={entry.icon} />
              {entry.title}
            </Item>
          )}
        </Fragment>
      ))}
      {!entries.length && <Item disabled>No actions available</Item>}
    </>
  );
}
export function ContributionMenu({
  bindings,
  location,
  context,
  trigger,
  label,
}: {
  bindings: MenuBindings;
  location: MenuLocation;
  context: MenuContext;
  trigger?: ReactElement;
  label?: string;
}) {
  return (
    <Dropdown.DropdownMenu>
      <Dropdown.DropdownMenuTrigger
        render={
          trigger ?? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              title={label}
            />
          )
        }
      >
        {!trigger && <MoreHorizontal />}
      </Dropdown.DropdownMenuTrigger>
      <Dropdown.DropdownMenuContent align="start">
        <ContributionItems
          bindings={bindings}
          location={location}
          context={context}
        />
      </Dropdown.DropdownMenuContent>
    </Dropdown.DropdownMenu>
  );
}
export function ContributionContextMenu({
  bindings,
  context,
  children,
}: {
  bindings: MenuBindings;
  context: MenuContext;
  children: ReactElement;
}) {
  return (
    <Context.ContextMenu>
      <Context.ContextMenuTrigger render={children} />
      <Context.ContextMenuContent>
        <ContributionItems
          bindings={bindings}
          location="explorer/context"
          context={context}
          contextMenu
        />
      </Context.ContextMenuContent>
    </Context.ContextMenu>
  );
}
