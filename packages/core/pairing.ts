import {
  ContactCard,
  uint8ArrayToHex,
} from "@automerge/automerge-repo-keyhive";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import type { PublicIdentity } from "./crypto";
import { invariant } from "@jocki/platform/core/errors";
export interface DeviceRequestOptions {
  name?: string;
  access?: "read" | "write";
  workspaceId?: string;
}
export interface DeviceRequest {
  format: "jocki-contact";
  contactCard: string;
  identity: PublicIdentity;
  access: "read" | "write";
  workspaceId?: string;
}
export interface PairingInvitation {
  format: "jocki-workspace-invitation";
  url: AutomergeUrl;
  workspaceId: string;
  name: string;
}
export function readDeviceRequest(value: string): DeviceRequest {
  invariant(
    value.length <= 65536,
    "INVALID_INVITATION",
    "Contact card is too large",
  );
  const request = JSON.parse(value) as DeviceRequest;
  invariant(
    request.format === "jocki-contact" &&
      ["read", "write"].includes(request.access) &&
      typeof request.identity?.name === "string",
    "INVALID_INVITATION",
    "Paste a Jocki Keyhive contact request",
  );
  const card = ContactCard.fromJson(request.contactCard);
  invariant(
    uint8ArrayToHex(card.id.toBytes()) === request.identity.id,
    "INVALID_INVITATION",
    "Contact identity does not match its Keyhive card",
  );
  return request;
}
export function readInvitation(value: string): PairingInvitation {
  invariant(
    value.length <= 65536,
    "INVALID_INVITATION",
    "Invitation is too large",
  );
  const invitation = JSON.parse(value) as PairingInvitation;
  invariant(
    invitation.format === "jocki-workspace-invitation" &&
      isValidAutomergeUrl(invitation.url) &&
      typeof invitation.workspaceId === "string" &&
      typeof invitation.name === "string",
    "INVALID_INVITATION",
    "Paste an Automerge workspace invitation",
  );
  return invitation;
}
