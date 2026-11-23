import { useReportedError } from "./errors";
import { useEffect, useState } from "react";
import {
  repositorySettings,
  saveRepositorySettings,
} from "../platform-browser/repository-settings";
import { browserDevice } from "../platform-browser/device";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import {
  defaultRepositorySettings,
  relayPresets,
  relayConnection,
  saveRelay,
  selectRelay,
  type RepositorySettings,
} from "../core/relay-settings";
export function RepositoryConnectionSettings() {
  const [settings, setSettings] = useState(defaultRepositorySettings),
    [loading, setLoading] = useState(true),
    [name, setName] = useState(""),
    [endpoints, setEndpoints] = useState(""),
    [identity, setIdentity] = useState("custom"),
    [card, setCard] = useState(""),
    [peer, setPeer] = useState(""),
    [, setError] = useReportedError("repository-settings"),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void repositorySettings()
      .then((settings) => {
        if (active) {
          setSettings(settings);
          edit(settings, settings.selected);
        }
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  function edit(value: RepositorySettings, id: string) {
    const saved = value.saved.find((relay) => relay.id === id);
    const connection = saved ?? value;
    setName(saved?.name ?? "");
    setEndpoints(connection.endpoints.join("\n"));
    setIdentity(
      typeof connection.syncServer === "string"
        ? connection.syncServer
        : "custom",
    );
    setCard(
      typeof connection.syncServer === "object"
        ? connection.syncServer.contactCardJson
        : "",
    );
    setPeer(
      typeof connection.syncServer === "object"
        ? connection.syncServer.peerId
        : "",
    );
  }
  const custom = !relayPresets.some((relay) => relay.id === settings.selected);
  return (
    <section className="space-y-3" aria-label="Sync connection">
      <h3 className="font-medium">Sync connection</h3>
      <p className="text-sm text-muted-foreground">
        Use the same relay on each device. Automerge is the default and relays
        encrypted shared data. Files stay local until you enable Sharing.
      </p>
      <label className="block space-y-2">
        Sync relay
        <select
          className="core-input w-full"
          aria-label="Sync relay"
          value={settings.selected}
          disabled={loading || busy}
          onChange={(event) => {
            const id = event.target.value;
            setError("");
            if (id === "custom") {
              setSettings({ ...settings, selected: id });
              setName("");
              setEndpoints("");
              setIdentity("custom");
              setCard("");
              setPeer("");
            } else {
              const next = selectRelay(settings, id);
              setSettings(next);
              edit(next, id);
            }
          }}
        >
          {relayPresets.map((relay) => (
            <option key={relay.id} value={relay.id}>
              {relay.name}
              {relay.id === "automerge" ? " (default)" : ""}
            </option>
          ))}
          {settings.saved.map((relay) => (
            <option key={relay.id} value={relay.id}>
              {relay.name}
            </option>
          ))}
          <option value="custom">Custom relay…</option>
        </select>
      </label>
      {!custom && (
        <p className="text-sm text-muted-foreground">
          {settings.endpoints.join(", ")}
        </p>
      )}
      {custom && (
        <div className="space-y-3">
          <label className="block space-y-2">
            Connection name
            <Input
              aria-label="Connection name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block space-y-2">
            WebSocket endpoints
            <Textarea
              aria-label="Relay WebSocket endpoints"
              rows={2}
              placeholder="wss://relay.example.com"
              value={endpoints}
              onChange={(event) => setEndpoints(event.target.value)}
            />
          </label>
          <label className="block space-y-2">
            Relay identity
            <select
              aria-label="Relay identity"
              className="core-input w-full"
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
            >
              <option value="custom">Custom Keyhive relay</option>
              <option value="keyhive">Automerge Keyhive</option>
              <option value="subduction">Automerge Subduction</option>
            </select>
          </label>
          {identity === "custom" && (
            <>
              <label className="block space-y-2">
                Public contact card
                <Textarea
                  aria-label="Relay contact card"
                  rows={3}
                  value={card}
                  onChange={(event) => setCard(event.target.value)}
                />
              </label>
              <label className="block space-y-2">
                Peer ID
                <Input
                  aria-label="Relay peer ID"
                  value={peer}
                  onChange={(event) => setPeer(event.target.value)}
                />
              </label>
            </>
          )}
          <p className="text-sm text-muted-foreground">
            This named connection is saved on this device for reuse.
          </p>
        </div>
      )}
      <Button
        variant="outline"
        disabled={busy || loading}
        onClick={() => {
          setBusy(true);
          setError("");
          void (async () => {
            let next = settings;
            if (custom) {
              const addresses = endpoints.split(/\s+/).filter(Boolean);
              if (!addresses.length) throw Error("Enter a WebSocket endpoint");
              next = saveRelay(settings, {
                id:
                  settings.selected === "custom"
                    ? crypto.randomUUID()
                    : settings.selected,
                name,
                ...relayConnection({
                  endpoints: addresses,
                  syncServer:
                    identity === "custom"
                      ? { contactCardJson: card.trim(), peerId: peer.trim() }
                      : identity,
                }),
              });
            }
            await (await browserDevice()).repository.flush();
            await saveRepositorySettings(next);
            if (!window.jockiNative?.repository) location.reload();
          })().catch((error) => {
            setError(String(error));
            setBusy(false);
          });
        }}
      >
        {window.jockiNative?.repository
          ? "Save and restart"
          : "Save and reload"}
      </Button>
    </section>
  );
}
