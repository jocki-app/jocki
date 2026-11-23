import type { AppRuntime } from "./runtime";
import type { PluginManifest } from "@jocki/platform/plugin-sdk";
import type {
  NavigationService,
  PluginCommand,
  SearchCollectionOptions,
} from "@jocki/platform/plugin-sdk/navigation";
import { invariant } from "@jocki/platform/core/errors";

export function navigationService(
  runtime: AppRuntime,
  manifest: PluginManifest,
): NavigationService {
  const id = manifest.id;
  return {
    registerHome: (destination) => {
      invariant(
        /^[a-z][a-z0-9.-]*$/.test(destination.id) &&
          destination.title.length > 0 &&
          destination.title.length <= 120 &&
          (!destination.page ||
            manifest.ui.surfaces.includes(destination.page) ||
            manifest.ui.pages?.some((p) => p.id === destination.page)),
        "INVALID_HOME",
        "Home destinations require an ID, title and declared page",
      );
      const key = id + ":" + destination.id;
      invariant(
        !runtime.homeDestinations.has(key),
        "CONTRACT_COLLISION",
        "Home destination already registered",
      );
      const registered = {
        id: destination.id,
        title: destination.title,
        page: destination.page,
        pluginId: id,
      };
      runtime.homeDestinations.set(key, registered);
      runtime.chooseInitialHome(key);
      runtime.notifySurfaces();
      return () => {
        if (runtime.homeDestinations.get(key) === registered)
          runtime.homeDestinations.delete(key);
        runtime.notifySurfaces();
      };
    },
    registerCommand: (command: PluginCommand) => {
      invariant(
        /^[a-z][a-z0-9.-]*$/.test(command.id) &&
          command.title.length > 0 &&
          command.title.length <= 120 &&
          typeof command.run === "function",
        "INVALID_COMMAND",
        "Commands require an ID, title, and explicit action",
      );
      const key = id + ":" + command.id;
      invariant(
        !runtime.commands.has(key),
        "CONTRACT_COLLISION",
        "Command ID is already registered",
      );
      const registered = {
        ...command,
        id: "command:" + key,
        pluginId: id,
        run: async () => {
          invariant(
            runtime.registry.enabled(id) &&
              runtime.commands.get(key) === registered &&
              (!command.enabled || command.enabled()),
            "FEATURE_DISABLED",
            "This command is no longer available",
          );
          if (command.page) await runtime.navigate(id, command.page);
          await command.run();
        },
      };
      runtime.commands.set(key, registered);
      runtime.notifySurfaces();
      return () => {
        if (runtime.commands.get(key) === registered)
          runtime.commands.delete(key);
        runtime.notifySurfaces();
      };
    },
    configureSearch: (options: SearchCollectionOptions) => {
      invariant(
        manifest.storage.local.collections.includes(options.collection),
        "UNDECLARED_COLLECTION",
        "Search configuration must belong to this plugin",
      );
      runtime.searchOptions.set(options.collection, options);
      runtime.notifySurfaces();
      return () => {
        if (runtime.searchOptions.get(options.collection) === options)
          runtime.searchOptions.delete(options.collection);
        runtime.notifySurfaces();
      };
    },
    navigate: (page?: string, recordId?: string) =>
      runtime.navigate(id, page, recordId),
  };
}
