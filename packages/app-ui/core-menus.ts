import type {
  UIContributionRegistry,
  MenuContribution,
  MenuLocation,
} from "../platform/src/file-sdk/ui-registry";
import type { CSDBImportSettings } from "../core/vaults/csdb-import";
import { defaultCSDBImportSettings } from "../core/vaults/csdb-import";
import type { ContentType } from "../core/vaults/contracts";
import type { VaultTemplate } from "./vault-shell";
/** Core uses the same namespaced declarations and rendering path as extensions. */
export function registerCoreMenus(
  registry: UIContributionRegistry,
  types: ContentType[],
  templates: VaultTemplate[],
  plugins: { id: string; name: string }[],
  commands: { id: string; label: string }[] = [],
  imports: CSDBImportSettings = defaultCSDBImportSettings(),
) {
  const entries: MenuContribution[] = [];
  for (const command of commands)
    entries.push({
      id: "core.palette." + command.id,
      command: "core.palette." + command.id,
      title: command.label,
      location: "commandPalette",
      group: "10.core",
    });
  const add = (
    id: string,
    title: string,
    location: MenuLocation,
    icon: string,
    options: Partial<MenuContribution> = {},
  ) =>
    entries.push({
      id: "core." + id,
      command: "core." + id,
      title,
      location,
      icon,
      ...options,
    });
  const folders = { kinds: ["vault", "folder"] as ("vault" | "folder")[] };
  for (const [index, [id, title, icon, submenu]] of [
    ["new-file", "New file", "FilePlus2", "explorer/new-file"],
  ].entries())
    add(id, title, "explorer/context", icon, {
      command: undefined,
      submenu: submenu as MenuLocation,
      when: folders,
      group: "10.create",
      order: index,
    });
  add("templates", "Template", "explorer/new-file", "BookTemplate", {
    command: undefined,
    submenu: "explorer/template",
    when: folders,
    group: "90.templates",
  });
  for (const [index, mode] of ["copy", "link"].entries())
    add(
      mode + "-template",
      mode === "copy" ? "Copy" : "Link",
      "explorer/template",
      mode === "copy" ? "Copy" : "Link2",
      {
        command: undefined,
        submenu:
          mode === "copy" ? "explorer/template-copy" : "explorer/template-link",
        when: folders,
        order: index,
      },
    );
  add("new-folder", "New folder", "explorer/context", "FolderPlus", {
    when: folders,
    group: "10.create",
    order: 1,
  });
  add("open-with", "Open with", "explorer/context", "FilePenLine", {
    command: undefined,
    submenu: "explorer/open-with",
    when: { kinds: ["file"] },
    group: "05.open",
  });
  add("add-data", "Add data", "explorer/context", "Upload", {
    command: undefined,
    submenu: "explorer/add-data",
    when: { kinds: ["file"], mime: "application/vnd.csdb" },
    group: "06.data",
    disabled: !imports.profiles.length,
  });
  const importMenu = (
    profile: string,
    location: MenuLocation,
    suffix: string,
  ) => {
    const templatesMenu: MenuLocation = `csdb/templates/${profile}`;
    add(`csdb.choose.${suffix}`, "Choose file…", location, "FilePlus2", {
      command: `core.csdb.choose.${profile}`,
      order: 0,
    });
    add(`csdb.template-menu.${suffix}`, "Template", location, "BookTemplate", {
      command: undefined,
      submenu: templatesMenu,
      order: 1,
    });
  };
  if (imports.profiles.length)
    importMenu(imports.default_profile, "explorer/add-data", "root");
  for (const profile of imports.profiles) {
    const location: MenuLocation = `csdb/import/${profile.id}`;
    add(
      `csdb.profile.${profile.id}`,
      profile.name,
      "explorer/add-data",
      "Table2",
      { command: undefined, submenu: location, group: "20.profiles" },
    );
    importMenu(profile.id, location, "profile." + profile.id);
    for (const template of templates.filter(
      (template) =>
        template.enabled !== false &&
        template.extension.toLowerCase() === ".csdb",
    ))
      add(
        `csdb.template.${profile.id}.${template.id}`,
        template.name,
        `csdb/templates/${profile.id}`,
        "BookTemplate",
      );
  }
  add("rename", "Rename", "explorer/context", "Pencil", {
    when: { kinds: ["file", "folder"] },
    group: "20.manage",
  });
  for (const location of [
    "explorer/context",
    "editor/toolbar",
    "workspace/context",
  ] as const)
    for (const feature of ["history", "sync"] as const)
      for (const enabled of [false, true]) {
        const name = feature === "history" ? "History" : "Sharing";
        const id = feature === "history" ? "history" : "share";
        add(
          `${location.replace("/", ".")}.${id}.${enabled ? "open" : "enable"}`,
          enabled ? name : `Enable ${name.toLowerCase()}`,
          location,
          feature === "history" ? "History" : "Share2",
          {
            command: "core." + id,
            when: { [feature]: enabled },
            group: "30.features",
            order: feature === "history" ? 0 : 1,
          },
        );
      }
  add(
    "recheck-metadata",
    "Clear metadata errors and recheck",
    "explorer/context",
    "RefreshCw",
    { when: { kinds: ["file"] }, group: "45.metadata" },
  );
  add(
    "designate-template",
    "Use as template",
    "explorer/context",
    "BookTemplate",
    { when: { kinds: ["file"] }, group: "50.templates" },
  );
  add("delete", "Delete", "explorer/context", "Trash2", {
    when: { kinds: ["file", "folder"] },
    destructive: true,
    group: "90.delete",
  });
  for (const type of [
    { id: "markdown", name: "Markdown" },
    { id: "text", name: "Text file" },
    { id: "csdb", name: "CSDB table" },
    { id: "canvas", name: "Canvas" },
    ...types,
  ])
    add("create." + type.id, type.name, "explorer/new-file", "FileText");
  for (const mode of ["copy", "link"] as const)
    for (const template of templates.filter((t) => t.enabled !== false))
      add(
        "template." + mode + "." + template.id,
        template.name,
        mode === "copy" ? "explorer/template-copy" : "explorer/template-link",
        "BookTemplate",
      );
  for (const [index, [id, title, icon]] of [
    ["workspace", "Workspace", "Workspace"],
    ["sharing", "Sharing", "Share2"],
    ["plugins", "Plugins", "Puzzle"],
    ["csdb", "CSDB imports", "Table2"],
    ["templates", "Templates and named paths", "BookTemplate"],
    ["shortcuts", "Keyboard shortcuts", "Keyboard"],
    ["logs", "Local logs", "ScrollText"],
  ].entries())
    add("page." + id, title, "settings", icon, {
      group: "10.core",
      order: index,
    });
  for (const plugin of plugins)
    add("page.plugin." + plugin.id, plugin.name, "settings", "Puzzle", {
      group: "20.plugins",
    });
  add("page.workspace", "Edit workspace", "workspace/context", "Workspace", {
    id: "core.workspace.edit",
  });
  add("new-workspace", "New workspace", "workspace/context", "Workspace");
  for (const [id, title, icon] of [
    ["copy", "Save copy as…", "Copy"],
    ["rename", "Move or rename", "Pencil"],
    ["template", "Apply template", "BookTemplate"],
    ["bookmark", "Bookmark", "Star"],
    ["pin", "Pin tab", "Pin"],
    ["popout", "Pop out", "ExternalLink"],
  ])
    add("editor." + id, title, "editor/title", icon, { group: "10.document" });
  registry.replace("core", entries);
}
