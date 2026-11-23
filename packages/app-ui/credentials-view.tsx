import { notify } from "../ui/notifications";
import { SharedInput } from "../ui/html-controls";
import { useState } from "react";
import { KeyRound, ShieldOff } from "lucide-react";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { field, type RecordSchema } from "@jocki/platform/field-types";
import { RecordTable } from "./record-table";
import { RecordForm } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import { membership } from "../core/membership";
const secret = (id: string, label: string, required = false) =>
  field(id, label, "text", {
    control: "password",
    sensitive: true,
    required,
    nullable: !required,
  });
function secretSchema(kind: string): RecordSchema {
  const fields =
    kind === "oauth2"
      ? [
          secret("access_token", "Access token", true),
          secret("refresh_token", "Refresh token"),
          field(
            "expires_at",
            "Access token expiry",
            "timestamp with time zone",
          ),
          field("client_id", "Client ID"),
          secret("client_secret", "Client secret"),
          field("token_endpoint", "Token endpoint", "text", { control: "url" }),
        ]
      : kind === "api-key"
        ? [secret("api_key", "API key", true)]
        : kind === "ssh-key"
          ? [
              field("username", "Username"),
              field("private_key", "Private key", "text", {
                control: "textarea",
                sensitive: true,
                required: true,
                nullable: false,
              }),
            ]
          : [
              field("username", "Username", "text", {
                required: true,
                nullable: false,
              }),
              secret("password", "Password", true),
            ];
  return {
    id: "credential_secret",
    pluginId: "credentials",
    version: 1,
    name: "Credential",
    fields,
  };
}
export default function CredentialsView({ runtime }: { runtime: AppRuntime }) {
  const [selected, setSelected] = useState<ResourceRecord | null>(null);
  const [deviceIds, setDeviceIds] = useState<string[]>([
    runtime.device.identity.id,
  ]);
  return (
    <div className="space-y-4">
      <RecordTable
        runtime={runtime}
        collection="credentials"
        renderActions={(row, { writable }) =>
          writable ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Set credential secret"
                onClick={() => {
                  setDeviceIds([runtime.device.identity.id]);
                  setSelected(row);
                }}
              >
                <KeyRound size={14} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Revoke credential"
                disabled={row.data.status === "revoked"}
                onClick={async () => {
                  try {
                    await runtime.api("credentials/revoke", { id: row.id });
                    notify.success("Credential revoked.");
                    await runtime.synchronize();
                  } catch (e) {
                    notify.error(e);
                  }
                }}
              >
                <ShieldOff size={14} />
              </Button>
            </>
          ) : null
        }
      />
      {selected && (
        <section
          className="rounded-lg border p-4 space-y-4"
          aria-label="Credential secret editor"
        >
          <div className="flex justify-between">
            <h3>Connect {String(selected.data.name ?? "credential")}</h3>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
          <fieldset className="space-y-2">
            <legend>Devices allowed to use this secret</legend>
            {Object.values(membership(runtime.node.replica.access).members)
              .filter((m) => m.access !== "read")
              .map((m) => (
                <label key={m.identity.id} className="flex gap-2 items-center">
                  <SharedInput
                    type="checkbox"
                    checked={deviceIds.includes(m.identity.id)}
                    disabled={m.identity.id === runtime.device.identity.id}
                    onChange={(e) =>
                      setDeviceIds(
                        e.target.checked
                          ? [...deviceIds, m.identity.id]
                          : deviceIds.filter((id) => id !== m.identity.id),
                      )
                    }
                  />
                  {m.identity.name}
                </label>
              ))}
          </fieldset>
          {selected && (
            <RecordForm
              key={selected.id}
              schema={secretSchema(String(selected.data.auth_kind))}
              onCancel={() => setSelected(null)}
              onSave={async (input) => {
                await runtime.synchronize();
                const secret = Object.fromEntries(
                  Object.entries(input)
                    .filter(([, v]) => v != null && v !== "")
                    .map(([key, value]) => [
                      key.replace(/_([a-z])/g, (_, letter) =>
                        letter.toUpperCase(),
                      ),
                      value,
                    ]),
                );
                await runtime.api("credentials/secret", {
                  id: selected.id,
                  secret,
                  deviceIds,
                });
                setSelected(null);
                notify.success("Credential secret saved.");
                await runtime.synchronize();
              }}
            />
          )}
          <p className="text-xs text-muted-foreground">
            For OAuth refresh, also authorize the exact token endpoint in this
            credential’s allowed destinations.
          </p>
        </section>
      )}
    </div>
  );
}
