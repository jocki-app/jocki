import {
  defaultRepositorySettings,
  validateRepositorySettings,
} from "../core/relay-settings";
export { validateRepositorySettings } from "../core/relay-settings";
export type { RepositorySettings } from "../core/relay-settings";
const key = "jocki.automerge.connection";
export async function repositorySettings() {
  if (window.jockiNative?.repository)
    return validateRepositorySettings(
      await window.jockiNative.repository.settings(),
    );
  const saved = localStorage.getItem(key);
  return saved
    ? validateRepositorySettings(JSON.parse(saved))
    : defaultRepositorySettings();
}
export async function saveRepositorySettings(settings: unknown) {
  const next = validateRepositorySettings(settings);
  if (window.jockiNative?.repository)
    await window.jockiNative.repository.configure(next);
  else localStorage.setItem(key, JSON.stringify(next));
}
