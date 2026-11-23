import {
  ContactCard,
  Access,
  uint8ArrayToHex,
} from "@automerge/automerge-repo-keyhive";
import { type AutomergeUrl } from "@automerge/automerge-repo";
import { membership } from "./membership";
import type { Replica } from "./replica";
import { ReplicaRecords } from "./records";
import { invariant } from "@jocki/platform/core/errors";
export type Secret = Record<string, string | undefined>;
interface VaultValue {
  url: AutomergeUrl;
  owner: string;
  sender: { id: string };
  recipients: Record<string, boolean>;
  revoked: boolean;
}
/** Each secret is a separate Keyhive-protected document. Workspace membership alone cannot read it. */
export class CredentialVault {
  readonly records: ReplicaRecords;
  private refreshing = new Map<string, Promise<void>>();
  constructor(
    readonly replica: Replica,
    private remoteRefresh?: (
      deviceId: string,
      id: string,
      pluginId: string,
      destination: string,
    ) => Promise<void>,
  ) {
    this.records = new ReplicaRecords(replica);
  }
  private canRefresh(value: VaultValue) {
    return value.sender.id === this.replica.identity.id;
  }
  async set(
    id: string,
    secret: Secret,
    deviceIds: string[] = [this.replica.identity.id],
  ) {
    const record = this.records.get(id);
    invariant(
      record?.collection === "credentials" &&
        record.ownerId === this.replica.member.userId,
      "PERMISSION_DENIED",
      "Only the credential owner can change secret material",
    );
    const old = this.replica.read<VaultValue>("vault/" + id);
    invariant(
      !old || old.sender.id === this.replica.identity.id,
      "PERMISSION_DENIED",
      "Edit this secret on its credential authority",
    );
    const repository = this.replica.access.repository;
    const cards = new Map<string, ContactCard>();
    for (const device of new Set(deviceIds)) {
      if (device === this.replica.identity.id) continue;
      const entry = this.replica.handle.doc()!.devices[device];
      invariant(
        entry?.contactCard && this.replica.access.membership.members[device],
        "NOT_FOUND",
        "Approve the credential recipient first",
      );
      const card = ContactCard.fromJson(entry.contactCard);
      invariant(
        uint8ArrayToHex(card.id.toBytes()) === device,
        "INVALID_INVITATION",
        "Recipient contact identity differs",
      );
      cards.set(device, card);
    }
    const handle = await repository.create({
      secret: JSON.parse(JSON.stringify(secret)) as Secret,
    });
    const recipients: Record<string, boolean> = {
      [this.replica.identity.id]: true,
    };
    for (const [device, card] of cards) {
      await repository.hive.addMemberToDoc(handle.url, card, Access.read());
      recipients[device] = true;
    }
    await repository.flush();
    if (old)
      for (const recipient of Object.keys(old.recipients))
        if (recipient !== this.replica.identity.id)
          await repository.hive.revokeMemberFromDoc(old.url, recipient);
    await this.replica.update("vault/" + id, {
      url: handle.url,
      owner: record.ownerId,
      sender: { id: this.replica.identity.id },
      recipients,
      revoked: false,
    });
    await this.records.put(
      "credentials",
      { ...record.data, status: "ready" },
      id,
    );
  }
  private async authorized(id: string, pluginId: string, destination: string) {
    const record = this.records.get(id),
      value = this.replica.read<VaultValue>("vault/" + id);
    invariant(
      record?.collection === "credentials" &&
        record.data.status === "ready" &&
        value &&
        !value.revoked,
      "CREDENTIAL_UNAVAILABLE",
      "Credential is not ready",
    );
    invariant(
      Array.isArray(record.data.allowed_plugins) &&
        record.data.allowed_plugins.includes(pluginId),
      "PERMISSION_DENIED",
      "Credential does not allow this plugin",
    );
    invariant(
      Array.isArray(record.data.allowed_destinations) &&
        record.data.allowed_destinations.includes(destination),
      "PERMISSION_DENIED",
      "Credential does not allow this destination",
    );
    const repository = this.replica.access.repository;
    invariant(
      value.recipients[this.replica.identity.id],
      "CREDENTIAL_UNAVAILABLE",
      "This identity has no Keyhive access to the credential",
    );
    await repository.waitForAccess(value.url, 15000);
    const access = await repository.hive.bestAccessForDoc(
      repository.hive.active.individual.id,
      value.url,
    );
    invariant(
      access?.isReader,
      "CREDENTIAL_UNAVAILABLE",
      "This identity has no Keyhive access to the credential",
    );
    const handle = await repository.repo.find<{ secret: Secret }>(value.url, {
      signal: AbortSignal.timeout(15000),
    });
    return { record, value, secret: handle.doc()!.secret };
  }
  async use<T>(
    id: string,
    pluginId: string,
    destination: string,
    execute: (secret: Secret) => Promise<T>,
  ) {
    let authorized = await this.authorized(id, pluginId, destination);
    const expiry = authorized.secret.expires_at ?? authorized.secret.expiresAt;
    if (expiry && Date.parse(expiry) <= Date.now() + 30000) {
      if (this.canRefresh(authorized.value))
        await this.refresh(id, pluginId, destination);
      else {
        invariant(
          this.remoteRefresh,
          "CREDENTIAL_EXPIRED",
          "Reconnect the credential authority",
        );
        await this.remoteRefresh(
          authorized.value.sender.id,
          id,
          pluginId,
          destination,
        );
      }
      authorized = await this.authorized(id, pluginId, destination);
    }
    return execute(structuredClone(authorized.secret));
  }
  async refresh(id: string, pluginId: string, destination: string) {
    const authorized = await this.authorized(id, pluginId, destination);
    invariant(
      this.canRefresh(authorized.value),
      "WRONG_EXECUTION_TARGET",
      "Refresh must run on the credential authority",
    );
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const work = async () => {
      const { record, value, secret } = await this.authorized(
          id,
          pluginId,
          destination,
        ),
        expiry = secret.expires_at ?? secret.expiresAt;
      if (expiry && Date.parse(expiry) > Date.now() + 30000) return;
      invariant(
        secret.refresh_token && secret.token_endpoint,
        "CREDENTIAL_EXPIRED",
        "Reconnect this credential to renew access",
      );
      const endpoint = new URL(secret.token_endpoint);
      invariant(
        endpoint.protocol === "https:" &&
          !endpoint.username &&
          !endpoint.password &&
          Array.isArray(record.data.allowed_destinations) &&
          record.data.allowed_destinations.includes(endpoint.href),
        "PERMISSION_DENIED",
        "Authorize the exact HTTPS token endpoint before refreshing",
      );
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: secret.refresh_token,
      });
      if (secret.client_id) form.set("client_id", secret.client_id);
      if (secret.client_secret) form.set("client_secret", secret.client_secret);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      invariant(
        response.ok,
        "CREDENTIAL_EXPIRED",
        "OAuth refresh failed; reconnect the account",
      );
      const body = await response.text();
      invariant(
        body.length < 65536,
        "PAYLOAD_TOO_LARGE",
        "OAuth response is too large",
      );
      const token = JSON.parse(body);
      invariant(
        typeof token.access_token === "string" && Number(token.expires_in) > 0,
        "CREDENTIAL_EXPIRED",
        "Token response lacks an access token or expiry",
      );
      await this.set(
        id,
        {
          ...secret,
          access_token: token.access_token,
          refresh_token:
            typeof token.refresh_token === "string"
              ? token.refresh_token
              : secret.refresh_token,
          expires_at: new Date(
            Date.now() + Math.min(Number(token.expires_in), 31536000) * 1000,
          ).toISOString(),
        },
        Object.keys(value.recipients).filter(
          (device) => membership(this.replica.access).members[device],
        ),
      );
    };
    const pending = work().finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, pending);
    return pending;
  }
  async revoke(id: string) {
    const record = this.records.get(id),
      value = this.replica.read<VaultValue>("vault/" + id);
    invariant(
      record?.ownerId === this.replica.member.userId,
      "PERMISSION_DENIED",
      "Only the credential owner can revoke it",
    );
    if (value) {
      invariant(
        value.sender.id === this.replica.identity.id,
        "PERMISSION_DENIED",
        "Revoke this secret on its credential authority",
      );
      for (const recipient of Object.keys(value.recipients))
        if (recipient !== this.replica.identity.id)
          await this.replica.access.repository.hive.revokeMemberFromDoc(
            value.url,
            recipient,
          );
      await this.replica.update("vault/" + id, {
        ...value,
        revoked: true,
        recipients: {},
      });
    }
    await this.records.put(
      "credentials",
      { ...record!.data, status: "revoked" },
      id,
    );
  }
}
