import { Capacitor, registerPlugin } from "@capacitor/core";
import type { NativeVaultBridge } from "./vault-runtime";
import { base64, unbase64 } from "../core/crypto";

interface MobileVaults {
  workspace(): Promise<{ computer: string; sandboxedExtensions: boolean }>;
  select(input?: {
    parentFor?: string;
  }): Promise<{ token?: string; name?: string; cancelled?: boolean }>;
  roots(): Promise<{ roots: { token: string; name: string }[] }>;
  files(input: {
    token: string;
    operation: string;
    path?: string;
    data?: string;
  }): Promise<{ data?: string | null; paths?: string[]; value?: unknown }>;
}
/** Platform folder pickers grant opaque local tokens; paths never come from sync. */
export async function mobileVaultBridge(): Promise<
  NativeVaultBridge | undefined
> {
  if (!Capacitor.isNativePlatform()) return;
  const native = registerPlugin<MobileVaults>("VaultFiles"),
    workspace = await native.workspace();
  return {
    fileInventory: true,
    rootCompanions: true,
    positionedFiles: Capacitor.getPlatform() === "ios",
    rangedReads: true,
    selectParent: async (token) => {
      const selected = await native.select({ parentFor: token });
      if (selected.cancelled) throw Error("Parent-folder access was cancelled");
    },
    sandboxedExtensions: workspace.sandboxedExtensions,
    workspace: async () => workspace,
    select: async () => {
      const selected = await native.select();
      return selected.cancelled
        ? null
        : { token: selected.token!, name: selected.name! };
    },
    roots: async () => (await native.roots()).roots,
    files: async (token, operation, path, bytes) => {
      const result = await native.files({
        token,
        operation,
        ...(path ? { path } : {}),
        ...(bytes ? { data: base64(bytes) } : {}),
      });
      if (
        ["scan", "stat", "root-scan", "root-stat", "root-access"].includes(
          operation,
        )
      )
        return result.value;
      return operation === "list" ||
        operation === "directories" ||
        operation === "root-list" ||
        operation === "root-directories"
        ? (result.paths ?? [])
        : result.data == null
          ? undefined
          : unbase64(result.data);
    },
  };
}
