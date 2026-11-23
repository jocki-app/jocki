import type { RepositoryOptions } from "./repository";
import { unbase64 } from "./crypto";

export type RelayConnection = Required<
  Pick<RepositoryOptions, "endpoints" | "syncServer">
>;
export interface SavedRelay extends RelayConnection {
  id: string;
  name: string;
}
export interface RepositorySettings extends RelayConnection {
  broadcast: boolean;
  selected: string;
  saved: SavedRelay[];
}
export const relayPresets: readonly SavedRelay[] = [
  {
    id: "automerge",
    name: "Automerge",
    endpoints: ["wss://keyhive.sync.automerge.org"],
    syncServer: "keyhive",
  },
];
export function defaultRepositorySettings(): RepositorySettings {
  const { id, name: _name, ...connection } = structuredClone(relayPresets[0]);
  return { ...connection, broadcast: false, selected: id, saved: [] };
}
export function relayConnection(value: unknown): RelayConnection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Enter a sync configuration object");
  const { endpoints = [], syncServer = "keyhive" } = value as RelayConnection;
  if (
    !Array.isArray(endpoints) ||
    endpoints.length > 16 ||
    endpoints.some((endpoint) => {
      if (typeof endpoint !== "string" || endpoint.length > 4096) return true;
      try {
        const url = new URL(endpoint);
        return (
          !["ws:", "wss:"].includes(url.protocol) ||
          Boolean(url.username || url.password || url.hash)
        );
      } catch {
        return true;
      }
    })
  )
    throw Error("Use ws:// or wss:// endpoints without embedded credentials");
  if (syncServer !== "keyhive" && syncServer !== "subduction") {
    if (
      !syncServer ||
      typeof syncServer !== "object" ||
      Array.isArray(syncServer) ||
      typeof syncServer.contactCardJson !== "string" ||
      !syncServer.contactCardJson.trim() ||
      syncServer.contactCardJson.length > 65536 ||
      typeof syncServer.peerId !== "string" ||
      !syncServer.peerId.trim() ||
      syncServer.peerId.length > 256
    )
      throw Error("Supply the relay's public Keyhive contact card and peer ID");
    try {
      const card = JSON.parse(syncServer.contactCardJson);
      if (!card || typeof card !== "object" || Array.isArray(card))
        throw Error();
    } catch {
      throw Error("The relay contact card must be a JSON object");
    }
    try {
      if (unbase64(syncServer.peerId.split("-")[0]).length !== 32)
        throw Error();
    } catch {
      throw Error("The relay peer ID must contain its base64 public key");
    }
  }
  return {
    endpoints: [...new Set(endpoints)],
    syncServer: structuredClone(syncServer),
  };
}
export function selectRelay(
  settings: RepositorySettings,
  id: string,
): RepositorySettings {
  const relay = [...relayPresets, ...settings.saved].find(
    (relay) => relay.id === id,
  );
  if (!relay) throw Error("Choose an available sync relay");
  return { ...settings, ...relayConnection(relay), selected: id };
}
export function validateRepositorySettings(value: unknown): RepositorySettings {
  const connection = relayConnection(value),
    input = value as RepositorySettings;
  if (
    input.saved !== undefined &&
    (!Array.isArray(input.saved) || input.saved.length > 16)
  )
    throw Error("Save up to 16 relay configurations");
  const saved = (input.saved ?? []).map((relay) => {
    if (
      !relay ||
      typeof relay.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(relay.id) ||
      ["automerge", "custom"].includes(relay.id) ||
      typeof relay.name !== "string" ||
      !relay.name.trim() ||
      relay.name.length > 80 ||
      /[\r\n]/.test(relay.name)
    )
      throw Error("Give each saved relay a name and a unique ID");
    const connection = relayConnection(relay);
    if (!connection.endpoints.length)
      throw Error("A saved relay needs a WebSocket endpoint");
    return { ...connection, id: relay.id, name: relay.name.trim() };
  });
  if (
    new Set(saved.map((relay) => relay.id)).size !== saved.length ||
    new Set(saved.map((relay) => relay.name.toLowerCase())).size !==
      saved.length
  )
    throw Error("Saved relay names and IDs must be unique");
  if (!connection.endpoints.length)
    throw Error(
      "Choose a relay with a WebSocket endpoint. Turn Broadcast off to keep changes local.",
    );
  const selected =
    input.selected ??
    (connection.syncServer === "keyhive" &&
    connection.endpoints.length === 1 &&
    connection.endpoints[0] === relayPresets[0].endpoints[0]
      ? "automerge"
      : "custom");
  if (typeof selected !== "string") throw Error("Choose a sync relay");
  if (input.broadcast !== undefined && typeof input.broadcast !== "boolean")
    throw Error("Broadcast must be on or off");
  const settings = {
    ...connection,
    broadcast: input.broadcast ?? false,
    selected,
    saved,
  };
  return selected === "custom" ? settings : selectRelay(settings, selected);
}
export function saveRelay(
  settings: RepositorySettings,
  relay: SavedRelay,
): RepositorySettings {
  return validateRepositorySettings({
    ...settings,
    ...relay,
    selected: relay.id,
    saved: [...settings.saved.filter((saved) => saved.id !== relay.id), relay],
  });
}
