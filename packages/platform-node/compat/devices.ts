import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Repository } from "./repository";
import type { Principal } from "@jocki/platform/plugin-sdk";
import { invariant } from "@jocki/platform/core/errors";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class DeviceService {
  constructor(private repo: Repository) {}
  async createEnrollment(principal: Principal) {
    invariant(
      (await this.repo.membership(principal, true)) === "write",
      "PERMISSION_DENIED",
      "Write access is required to pair devices",
    );
    const code = randomBytes(12).toString("base64url"),
      expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    await this.repo.db.query(
      "INSERT INTO jocki.enrollments(code_hash,workspace_id,user_id,expires_at) VALUES($1,$2,$3,$4)",
      [hashToken(code), principal.workspaceId, principal.userId, expiresAt],
    );
    return { code, expiresAt };
  }
  async enroll(
    code: string,
    name: string,
    platform: string,
    capabilities: string[],
    publicKey: string,
  ) {
    const principal = await this.repo.db.transaction(async (tx) => {
      const result = await tx.query<{ workspace_id: string; user_id: string }>(
        "DELETE FROM jocki.enrollments WHERE code_hash=$1 AND expires_at>now() RETURNING workspace_id,user_id",
        [hashToken(code)],
      );
      invariant(
        result.rows[0],
        "INVALID_ENROLLMENT",
        "Pairing code is invalid or expired",
      );
      return {
        workspaceId: result.rows[0].workspace_id,
        userId: result.rows[0].user_id,
        pluginId: "devices",
        permissions: ["devices.read", "devices.write"],
      };
    });
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    invariant(
      ["desktop", "server", "runner", "browser", "ios", "android"].includes(
        platform,
      ),
      "VALIDATION_FAILED",
      "Unknown device platform",
    );
    const permitted = capabilities.filter((c) =>
      ["automation.execute", "terminal.host"].includes(c),
    );
    if (platform === "browser" || platform === "ios" || platform === "android")
      invariant(
        permitted.length === 0,
        "CAPABILITY_UNSUPPORTED",
        "This runtime cannot host OS shells or Node.js workflows",
      );
    await this.repo.mutate(principal, {
      id: randomUUID(),
      resourceId: id,
      pluginId: "devices",
      collection: "devices",
      operation: "put",
      baseRevision: 0,
      data: {
        name,
        platform,
        capabilities: permitted,
        last_seen: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    });
    await this.repo.db.query(
      "INSERT INTO jocki.device_keys(device_id,public_key,token_hash,last_seen) VALUES($1,$2,$3,now())",
      [id, publicKey, hashToken(token)],
    );
    return {
      deviceId: id,
      token,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      gatewayUrl: process.env.PUBLIC_GATEWAY_URL ?? "/device-stream",
    };
  }
  async authenticate(deviceId: string, token: string) {
    const result = await this.repo.db.query<{
      workspace_id: string;
      owner_id: string;
      lease_epoch: number;
    }>(
      "SELECT r.workspace_id,r.owner_id,k.lease_epoch FROM jocki.device_keys k JOIN jocki.resources r ON r.id=k.device_id JOIN jocki.p_devices d ON d.id=k.device_id WHERE k.device_id=$1 AND k.token_hash=$2 AND k.revoked_at IS NULL AND NOT d.revoked AND r.deleted_at IS NULL",
      [deviceId, hashToken(token)],
    );
    invariant(
      result.rows[0],
      "UNAUTHENTICATED",
      "Device identity is invalid or revoked",
    );
    return result.rows[0];
  }
  async heartbeat(deviceId: string, token: string) {
    await this.authenticate(deviceId, token);
    await this.repo.db.query(
      "UPDATE jocki.device_keys SET last_seen=now() WHERE device_id=$1",
      [deviceId],
    );
    await this.repo.db.query(
      "UPDATE jocki.p_devices SET last_seen=now() WHERE id=$1",
      [deviceId],
    );
  }
  async connect(deviceId: string, token: string) {
    const identity = await this.authenticate(deviceId, token);
    const row = (
      await this.repo.db.query<{ lease_epoch: number }>(
        "UPDATE jocki.device_keys SET lease_epoch=lease_epoch+1,last_seen=now() WHERE device_id=$1 RETURNING lease_epoch",
        [deviceId],
      )
    ).rows[0];
    await this.repo.db.query(
      "UPDATE jocki.p_devices SET lease_epoch=$2,last_seen=now() WHERE id=$1",
      [deviceId, row.lease_epoch],
    );
    return { ...identity, lease_epoch: row.lease_epoch };
  }
  async revoke(principal: Principal, id: string) {
    await this.repo.membership(principal, true);
    const record = await this.repo.get(principal, id);
    invariant(
      record.collection === "devices",
      "PERMISSION_DENIED",
      "Choose an approved device to revoke",
    );
    await this.repo.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE jocki.device_keys SET revoked_at=now(),lease_epoch=lease_epoch+1 WHERE device_id=$1",
        [id],
      );
      await tx.query(
        "DELETE FROM jocki.stream_tickets WHERE device_id=$1",
        [id],
      );
    });
    await this.repo.mutate(principal, {
      id: randomUUID(),
      resourceId: id,
      pluginId: "devices",
      collection: "devices",
      operation: "put",
      baseRevision: record.revision,
      data: { ...record.data, revoked: true },
      createdAt: new Date().toISOString(),
    });
  }
  async terminalTicket(principal: Principal, deviceId: string) {
    const resource = await this.repo.get(principal, deviceId);
    invariant(
      resource.ownerId === principal.userId,
      "PERMISSION_DENIED",
      "Terminal access is limited to the enrolled device owner",
    );
    invariant(
      Array.isArray(resource.data.capabilities) &&
        resource.data.capabilities.includes("terminal.host"),
      "CAPABILITY_UNSUPPORTED",
      "This device does not offer a terminal",
    );
    const key = (
      await this.repo.db.query<{ last_seen: string }>(
        "SELECT last_seen FROM jocki.device_keys WHERE device_id=$1 AND revoked_at IS NULL",
        [deviceId],
      )
    ).rows[0];
    invariant(
      key && Date.now() - new Date(key.last_seen).getTime() < 45000,
      "DEVICE_OFFLINE",
      "The selected device is offline",
    );
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID();
    await this.repo.db.query(
      "INSERT INTO jocki.stream_tickets(id,token_hash,device_id,workspace_id,user_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '60 seconds')",
      [id, hashToken(token), deviceId, principal.workspaceId, principal.userId],
    );
    return {
      sessionId: id,
      ticket: token,
      gatewayUrl: process.env.PUBLIC_GATEWAY_URL ?? "/device-stream",
    };
  }
}
