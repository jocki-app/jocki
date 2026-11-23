export interface NativeSettings {
  terminal: boolean;
  automation: boolean;
  trustedCode: boolean;
  background: boolean;
  plugins: boolean;
}
export interface NativeInfo {
  id: string;
  request: string;
  addresses: string[];
  workspaces: string[];
  options: NativeSettings;
}
declare global {
  interface Window {
    jockiNative?: {
      timers?: {
        present(
          value: import("@jocki/platform/plugin-sdk/timers").TimerPresentation,
        ): Promise<void>;
        requestPermission(): Promise<boolean>;
        subscribe(
          listener: (timer: { pluginId: string; id: string }) => void,
        ): () => void;
      };
      database: {
        settings(): Promise<
          import("../storage/database").DatabaseWorkingStorage
        >;
        configure(
          value: import("../storage/database").DatabaseWorkingStorage,
        ): Promise<import("../storage/database").DatabaseWorkingStorage>;
      };
      repository: {
        storage(
          bucket: "documents" | "identity",
          operation: "load" | "save" | "remove" | "loadRange" | "removeRange",
          key: string[],
          bytes?: Uint8Array,
        ): Promise<unknown>;
        batch(
          bucket: "documents" | "identity",
          entries: Array<[string[], Uint8Array]>,
        ): Promise<void>;
        extensions(
          contracts: import("./plugin-host").ExtensionContract[],
        ): Promise<void>;
        settings(): Promise<
          import("../platform-browser/repository-settings").RepositorySettings
        >;
        configure(
          settings: import("../platform-browser/repository-settings").RepositorySettings,
        ): Promise<void>;
        connect(): Promise<void>;
        remove(id: string): Promise<void>;
        profiles(): Promise<import("../core/device").LinkedWorkspace[]>;
        activate(link: import("../core/device").LinkedWorkspace): Promise<void>;
        execute(
          workspaceId: string,
          command: string,
          input: unknown,
          context: { deviceId: string; requestId: string },
        ): Promise<unknown>;
      };
      peer: {
        info(): Promise<NativeInfo>;
        configure(options: NativeSettings): Promise<NativeInfo>;
      };
    };
  }
}
/** Compatibility helper for public plugin assets. Workspace operations use core peer RPC. */
export const serverFetch = (input: string | URL, options: RequestInit = {}) =>
  fetch(input, { ...options, credentials: "omit" });
export const defaultServerUrl = () => location.origin;
