import type { SettingsService } from "@jocki/platform/plugin-sdk/peers";
import type { Replica } from "./replica";
export function pluginSettings(
  replica: Replica,
  pluginId: string,
): SettingsService {
  return {
    get: async <T>(key: string) =>
      replica.read<{ value: T }>(`setting/plugin.${pluginId}.${key}`)?.value,
    set: (key, value) =>
      replica.update(`setting/plugin.${pluginId}.${key}`, { value }),
    computer: {
      get: async <T>(key: string) =>
        replica.computerSettings.get<T>(`plugin.${pluginId}.${key}`),
      set: (key, value) =>
        replica.computerSettings.set(`plugin.${pluginId}.${key}`, value),
    },
  };
}
