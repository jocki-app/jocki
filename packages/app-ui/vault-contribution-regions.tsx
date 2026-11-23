import { useEffect, useState, type ReactNode } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/primitives/popover";
import { Button } from "../ui/primitives/button";
import { ContributionIcon } from "./contribution-menu";
import type { FileExtensionHost } from "../platform/src/file-sdk/host";

export interface FileViewContribution {
  id: string;
  title: string;
  extension: string;
  plugin: string;
  icon?: string;
}
export function FileViewPicker({
  file,
  current,
  views,
  onChoose,
}: {
  file: string;
  current?: string;
  views: FileViewContribution[];
  onChoose(view: FileViewContribution): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = views.find((view) => view.id === current);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`View for ${file}`}
            title={`Current view: ${selected?.title ?? "Edit"}`}
          />
        }
      >
        <ContributionIcon name={selected?.icon ?? "FilePenLine"} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2"
        aria-label="File views"
      >
        {[...new Set(views.map((view) => view.extension))].map((extension) => {
          const group = views.filter((view) => view.extension === extension);
          return (
            <section
              key={extension}
              className="space-y-1 p-2"
              data-view-plugin={extension}
            >
              <div className="text-xs font-medium text-muted-foreground">
                {group[0].plugin}
              </div>
              <div className="flex flex-wrap gap-1">
                {group.map((view) => (
                  <Button
                    key={view.id}
                    variant={current === view.id ? "secondary" : "ghost"}
                    size="icon"
                    title={view.title}
                    aria-label={view.title}
                    aria-pressed={current === view.id}
                    onClick={() => {
                      setOpen(false);
                      onChoose(view);
                    }}
                  >
                    <ContributionIcon name={view.icon} />
                  </Button>
                ))}
              </div>
            </section>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
export function VaultStatusBar({
  host,
  execute,
}: {
  host: FileExtensionHost;
  execute(command: string): void;
}) {
  const [, update] = useState(0);
  useEffect(() => {
    const subscription = host.onDidChangeStatus(() =>
      update((value) => value + 1),
    );
    return () => subscription.dispose();
  }, [host]);
  const items = host.statusItems();
  const render = (alignment: "left" | "right") => {
    const group = items.filter(
      (item) => (item.alignment ?? "right") === alignment,
    );
    if (alignment === "right") group.reverse();
    return group.map((item) =>
      item.command ? (
        <Button
          key={item.id}
          variant="ghost"
          size="sm"
          className="h-6 px-1 text-xs"
          title={item.tooltip}
          onClick={() => execute(item.command!)}
          data-status-item={item.id}
        >
          {item.text}
        </Button>
      ) : (
        <span key={item.id} title={item.tooltip} data-status-item={item.id}>
          {item.text}
        </span>
      ),
    );
  };
  return (
    <footer
      aria-label="Status bar"
      data-vault-statusbar
      className="flex h-7 min-w-0 shrink-0 items-center gap-3 border-t px-3 text-xs text-muted-foreground"
    >
      <div className="flex min-w-0 items-center gap-3 overflow-x-auto">
        {render("left")}
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-3 overflow-x-auto whitespace-nowrap">
        {render("right")}
      </div>
    </footer>
  );
}
export function VaultNavigation({
  host,
  selected,
  onSelect,
  children,
  footer,
}: {
  host: FileExtensionHost;
  selected: string;
  onSelect(id: string): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-navigation-pane>
      <nav
        className="flex shrink-0 gap-1 border-b p-2"
        aria-label="Navigation views"
      >
        {host
          .viewContributions()
          .filter((view) => view.location === "navigation")
          .map((view) => (
            <Button
              key={view.id}
              variant={selected === view.id ? "secondary" : "ghost"}
              size="icon"
              aria-label={`Browse ${view.title}`}
              title={view.title}
              aria-pressed={selected === view.id}
              onClick={() => onSelect(view.id)}
            >
              <ContributionIcon name={view.icon} />
            </Button>
          ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {footer && (
        <footer className="shrink-0 border-t p-2" data-navigation-footer>
          {footer}
        </footer>
      )}
    </div>
  );
}
