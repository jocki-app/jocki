import { openNodeRepository } from "./repository";
import type { Repository, RepositoryOptions } from "../core/repository";
import path from "node:path";
import os from "node:os";
import { FileStorage } from "./storage";
import { DeviceCore } from "../core/device";
import { NativeServices, type NativeOptions } from "./services";
import type { DurableStorage } from "../storage";
import { snapshotStorage } from "../storage";
import { lockDirectory } from "./lock";
import { reportSyncError } from "../sync/errors";
import { relayConnection } from "../core/relay-settings";
import { readRepositorySettings } from "./repository-settings";
export async function startNativeRuntime(
  options: Partial<NativeOptions> & {
    directory: string;
    name?: string;
    sync?: Omit<RepositoryOptions, "documents" | "identity">;
    createWorkspace?: string;
    workspaceFolder?: string;
    storage?: DurableStorage;
    syncIntervalMs?: number;
    /** Desktop opens only the selected workspace; headless defaults to every linked workspace. */
    activeWorkspaces?: string[];
  },
) {
  const interval = options.syncIntervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 3600000)
    throw Error("Invalid synchronization interval");
  const unlock = await lockDirectory(options.directory);
  let unlockRepository: (() => Promise<void>) | undefined;
  let services: NativeServices | undefined;
  let core: DeviceCore | undefined;
  let repository: Repository | undefined;
  try {
    if (
      options.workspaceFolder &&
      path.resolve(options.workspaceFolder) !== path.resolve(options.directory)
    )
      unlockRepository = await lockDirectory(options.workspaceFolder);
    const storage = snapshotStorage(
      options.storage ?? new FileStorage(path.join(options.directory, "local")),
    );
    let sync = options.sync;
    if (!sync) {
      const settings = await readRepositorySettings(options.directory);
      sync = {
        ...relayConnection(settings),
        endpoints: settings.broadcast ? settings.endpoints : [],
      };
    }
    repository = await openNodeRepository(
      options.workspaceFolder ?? path.join(options.directory, "automerge"),
      sync,
    );
    core = await DeviceCore.open(
      storage,
      options.name ?? os.hostname(),
      () => services?.capabilities() ?? [],
      repository,
    );
    if (!core.profiles().length && options.createWorkspace)
      await core.createWorkspace(options.createWorkspace);
    services = new NativeServices(core, {
      directory: options.directory,
      storageOnly: options.storageOnly ?? false,
      terminal: options.terminal ?? false,
      automation: options.automation ?? false,
      trustedCode: options.trustedCode ?? false,
      background: options.background ?? false,
      plugins: options.plugins ?? false,
    });
    await services.initialize(options.activeWorkspaces);
    const device = core;
    core.startAutomaticSync(interval);
    let changing = false,
      selection: Promise<void> = Promise.resolve();
    let scheduled = false;
    let stopping = false,
      pending: Promise<void> = Promise.resolve();
    const tick = () => {
      if (scheduled || stopping || changing) return;
      scheduled = true;
      pending = pending
        .then(async () => {
          if (stopping) return;
          await services!.tick();
        })
        .catch((error) => {
          reportSyncError(error, { phase: "background-services" });
        })
        .finally(() => {
          scheduled = false;
        });
    };
    tick();
    const timer = setInterval(tick, interval);
    timer.unref();
    return {
      core,
      services,
      addresses: () => sync?.endpoints ?? [],
      prepareWorkspace(work: () => Promise<void>) {
        selection = selection
          .catch(() => {})
          .then(async () => {
            changing = true;
            try {
              await pending;
              await work();
            } finally {
              changing = false;
            }
          });
        return selection;
      },
      selectWorkspace(id?: string) {
        selection = selection
          .catch(() => {})
          .then(async () => {
            changing = true;
            try {
              await pending;
              for (const active of [...device.workspaces.keys()])
                if (active !== id) await services!.detachWorkspace(active);
              if (id) await services!.attachWorkspace(id);
            } finally {
              changing = false;
            }
          });
        return selection;
      },
      removeWorkspace(id: string) {
        selection = selection
          .catch(() => {})
          .then(async () => {
            changing = true;
            try {
              await pending;
              await services!.removeWorkspace(id);
            } finally {
              changing = false;
            }
          });
        return selection;
      },
      async close() {
        stopping = true;
        clearInterval(timer);
        await selection.catch(() => {});
        await pending;
        try {
          try {
            await services!.close();
          } finally {
            await device.close();
          }
        } finally {
          await unlockRepository?.();
          await unlock();
        }
      },
    };
  } catch (error) {
    reportSyncError(error, { phase: "runtime-startup" });
    await services?.close().catch((cleanupError) => {
      reportSyncError(cleanupError, { phase: "startup-cleanup-services" });
    });
    await core?.close().catch((cleanupError) => {
      reportSyncError(cleanupError, { phase: "startup-cleanup-core" });
    });
    if (!core) await repository?.close();
    await unlockRepository?.();
    await unlock();
    throw error;
  }
}
