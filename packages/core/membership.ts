import { fromHex } from "./crypto";
import type { DocHandle } from "@automerge/automerge-repo";
import { Identifier, uint8ArrayToHex } from "@automerge/automerge-repo-keyhive";
import type { PublicIdentity } from "./crypto";
import type { ComputerSettingsDocument } from "./computer-settings";
import type { Repository } from "./repository";

export interface WorkspaceDocument {
  format: "jocki-workspace";
  id: string;
  name: string;
  ownerId: string;
  devices: Record<string, PublicIdentity & { contactCard: string }>;
  accessGroup: string;
  defaultSchemaId: string;
  schemas: Record<string, import("@automerge/automerge-repo").AutomergeUrl>;
  sharedSettings: import("@automerge/automerge-repo").AutomergeUrl;
}
export interface WorkspaceMember {
  identity: PublicIdentity;
  userId: string;
  access: "read" | "write";
  admin: boolean;
}
export interface WorkspaceMembership {
  workspaceId: string;
  name: string;
  userId: string;
  members: Record<string, WorkspaceMember>;
}
export interface WorkspaceAccess {
  repository: Repository;
  handle: DocHandle<WorkspaceDocument>;
  membership: WorkspaceMembership;
  computer: DocHandle<ComputerSettingsDocument>;
}
export const membership = (access: WorkspaceAccess) => access.membership;
export function userIdFor(id: string) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
}
export async function refreshMembership(access: WorkspaceAccess) {
  const doc = access.handle.doc();
  if (!doc) throw Error("Workspace is unavailable");
  const members: Record<string, WorkspaceMember> = {};
  for (const [id, identity] of Object.entries(doc.devices)) {
    if (!/^[a-f0-9]{64}$/.test(id)) continue;
    const granted = await access.repository.hive.bestAccessForDoc(
      new Identifier(fromHex(id)),
      access.handle.url,
    );
    if (!granted?.isReader) continue;
    members[id] = {
      identity,
      userId: doc.ownerId,
      access: granted.isEditor ? "write" : "read",
      admin: granted.toString().toLowerCase() === "admin",
    };
  }
  access.membership = {
    workspaceId: doc.id,
    name: doc.name,
    userId: doc.ownerId,
    members,
  };
}
export function repositoryIdentity(repository: Repository) {
  return uint8ArrayToHex(repository.hive.active.individual.id.toBytes());
}
export function defaultServiceDevice(value: WorkspaceMembership) {
  return Object.values(value.members).find((member) => member.admin)?.identity
    .id;
}
