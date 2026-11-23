import type { ComputerSettingsDocument } from "./computer-settings";
import type { SharedSettingsDocument } from "./document-graph";
import { schemaResourceId } from "./item-schemas";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { DurableStorage } from "../storage";
import { publicIdentity, utf8, text, canonical, type Identity } from "./crypto";
import { Repository } from "./repository";
import {
  repositoryIdentity,
  userIdFor,
  refreshMembership,
  type WorkspaceAccess,
  type WorkspaceDocument,
} from "./membership";
import { Replica } from "./replica";
import { ReplicaRecords, deviceRecordId } from "./records";
import { CredentialVault } from "./vault";
import { PeerProtocol, type CommandHandler } from "../sync/protocol";
import { LocalState } from "./local-state";
import {
  readInvitation,
  readDeviceRequest,
  type DeviceRequestOptions,
  type PairingInvitation,
} from "./pairing";
import { defaultWorkspaceSettings } from "./workspace-settings";
import { invariant } from "@jocki/platform/core/errors";
export interface LinkedWorkspace {
  id: string;
  name: string;
  url: AutomergeUrl;
  computerSettings?: AutomergeUrl;
}
export class WorkspaceNode {
  readonly records: ReplicaRecords;
  readonly vault: CredentialVault;
  readonly protocol: PeerProtocol;
  readonly peerDevices = new Map<
    string,
    {
      address: string;
      deviceId: string;
      name: string;
      capabilities: string[];
      lastSeen: number;
    }
  >();
  private closed = false;
  private automatic?: ReturnType<typeof setInterval>;
  private commandQueue?: Promise<void>;
  constructor(
    readonly replica: Replica,
    public link: LinkedWorkspace,
    capabilities: () => string[] = () => [],
    handler?: CommandHandler,
    commandHost = true,
  ) {
    this.records = new ReplicaRecords(replica);
    this.vault = new CredentialVault(
      replica,
      async (device, id, pluginId, destination) => {
        await this.call(
          "credentials.refresh",
          { id, pluginId, destination },
          device,
        );
      },
    );
    this.protocol = new PeerProtocol(
      replica,
      capabilities,
      handler,
      commandHost,
    );
    this.protocol.connections.add((id, info) => {
      const known = this.peerDevices.has(id);
      this.peerDevices.set(id, {
        address: id,
        deviceId: id,
        name: info.name,
        capabilities: info.capabilities,
        lastSeen: Date.now(),
      });
      if (!known) void this.protocol.announce();
    });
  }
  get lifecycle() {
    return {
      phase: this.closed ? ("closed" as const) : ("ready" as const),
      revision: 1,
    };
  }
  async synchronize(_mode: "manual" | "background" = "manual") {
    invariant(!this.closed, "WORKSPACE_CLOSED", "Workspace is closed");
    const { repository } = this.replica.access;
    for (const handle of this.replica.graph.sharedHandles())
      repository.repo.resyncSubduction(handle.documentId);
    repository.hive.networkAdapter.syncKeyhive();
    await refreshMembership(this.replica.access);
    await this.replica.flush();
    await this.protocol.announce();
    await this.flushCommands();
  }
  startAutomaticSync(interval = 15000, canRun: () => boolean = () => true) {
    if (this.automatic) return;
    this.automatic = setInterval(() => {
      if (canRun())
        void this.synchronize("background").catch((error) => {
          this.replica.error = String(error);
        });
    }, interval);
    this.automatic.unref?.();
  }
  async pauseAutomaticSync() {
    clearInterval(this.automatic);
    this.automatic = undefined;
  }
  wakeAutomaticSync() {
    void this.synchronize("background").catch((error) => {
      this.replica.error = String(error);
    });
  }
  async call(
    command: string,
    input: unknown,
    targetDeviceId?: string,
    requestId: string = crypto.randomUUID(),
  ) {
    invariant(!this.closed, "WORKSPACE_CLOSED", "Workspace is closed");
    if (
      targetDeviceId === this.replica.identity.id ||
      targetDeviceId === deviceRecordId(this.replica.identity.id)
    )
      return this.protocol.localCall(command, input, requestId);
    const peer = [...this.peerDevices.values()].find(
      (peer) =>
        Date.now() - peer.lastSeen < 45000 &&
        (!targetDeviceId ||
          targetDeviceId === peer.deviceId ||
          targetDeviceId === deviceRecordId(peer.deviceId)) &&
        (peer.capabilities.includes(command) ||
          peer.capabilities.includes(command.split(".")[0] + ".*")),
    );
    invariant(
      peer,
      "DEVICE_UNAVAILABLE",
      "No online approved device offers this operation",
    );
    return this.protocol.call(command, input, peer.deviceId, requestId);
  }
  async enqueue(
    command: string,
    input: unknown,
    targetDeviceId: string,
    requestId: string,
    expiresAt: number,
  ) {
    invariant(
      targetDeviceId &&
        expiresAt > Date.now() &&
        expiresAt - Date.now() <= 86400000,
      "INVALID_COMMAND",
      "Select a device and an expiry within 24 hours",
    );
    const store = new LocalState(this.replica, "outgoing-commands");
    const prior = await store.get<{
      command: string;
      input: unknown;
      targetDeviceId: string;
    }>(requestId);
    invariant(
      !prior ||
        canonical([prior.command, prior.input, prior.targetDeviceId]) ===
          canonical([command, input, targetDeviceId]),
      "IDEMPOTENCY_CONFLICT",
      "Command ID was reused",
    );
    if (!prior)
      await store.set(requestId, {
        command,
        input,
        targetDeviceId,
        expiresAt,
        status: "queued",
      });
  }
  async flushCommands() {
    if (this.commandQueue) return this.commandQueue;
    this.commandQueue = (async () => {
      const store = new LocalState(this.replica, "outgoing-commands");
      for (const id of await store.ids()) {
        const value = await store.get<{
          command: string;
          input: unknown;
          targetDeviceId: string;
          expiresAt: number;
          status: string;
        }>(id);
        if (!value || value.status !== "queued") continue;
        if (value.expiresAt <= Date.now()) value.status = "expired";
        else {
          try {
            await this.call(
              value.command,
              value.input,
              value.targetDeviceId,
              id,
            );
            value.status = "accepted";
          } catch {
            continue;
          }
        }
        await store.set(id, value);
      }
    })().finally(() => {
      this.commandQueue = undefined;
    });
    return this.commandQueue;
  }
  async quiesce() {
    this.closed = true;
    this.replica.graph.cancelLoads();
    await this.pauseAutomaticSync();
    await this.commandQueue;
    await this.protocol.close();
    await this.replica.freezeWrites();
  }
  async stop() {
    try {
      await this.quiesce();
    } finally {
      this.replica.deactivate();
    }
  }
}
/** Local workspace catalog and application services. Keyhive owns authority; Repo owns synchronization. */
export class DeviceCore {
  readonly workspaces = new Map<string, WorkspaceNode>();
  readonly protocols = new Map<string, PeerProtocol>();
  private links: LinkedWorkspace[] = [];
  private capabilityProvider: () => string[];
  private constructor(
    readonly storage: DurableStorage,
    readonly repository: Repository,
    readonly identity: Identity,
    capabilities: () => string[],
    private readonly commandHost: boolean,
  ) {
    this.capabilityProvider = capabilities;
  }
  static async open(
    storage: DurableStorage,
    name: string,
    capabilities: () => string[] = () => [],
    repository?: Repository,
    options: { commandHost?: boolean } = {},
  ) {
    invariant(
      repository,
      "CAPABILITY_UNSUPPORTED",
      "Provide an Automerge repository storage capability at startup",
    );
    const identity: Identity = { id: repositoryIdentity(repository), name };
    const core = new DeviceCore(
      storage,
      repository,
      identity,
      capabilities,
      options.commandHost ?? true,
    );
    const catalog = await storage.get("device/workspace-graph");
    core.links = catalog
      ? (JSON.parse(text.decode(catalog)) as LinkedWorkspace[])
      : [];
    return core;
  }
  profiles() {
    return structuredClone(this.links);
  }
  setCapabilities(provider: () => string[]) {
    this.capabilityProvider = provider;
  }
  private async save() {
    await this.storage.set(
      "device/workspace-graph",
      utf8.encode(JSON.stringify(this.links)),
    );
  }
  async workspace(
    id: string,
    handler?: CommandHandler,
    progress: (message: string) => void = () => {},
  ) {
    const existing = this.workspaces.get(id);
    if (existing) {
      if (handler) existing.protocol.setHandler(handler);
      return existing;
    }
    const link = this.links.find((link) => link.id === id);
    invariant(link, "NOT_FOUND", "Workspace is not saved on this device");
    const handle = await this.repository.load<WorkspaceDocument>(link.url);
    invariant(
      handle.doc()?.format === "jocki-workspace" && handle.doc()?.id === id,
      "INVALID_WORKSPACE",
      "This is not a Jocki Repo workspace",
    );
    await this.repository.enableRelay(handle);
    if (!link.computerSettings) {
      const computer = await this.repository.create<ComputerSettingsDocument>({
        format: "jocki-computer-settings",
        workspaceId: id,
        computerId: this.identity.id,
        values: {},
      });
      link.computerSettings = computer.url;
      await this.save();
    }
    const computer = await this.repository.load<ComputerSettingsDocument>(
      link.computerSettings,
    );
    invariant(
      computer.doc()?.format === "jocki-computer-settings" &&
        computer.doc()?.workspaceId === id &&
        computer.doc()?.computerId === this.identity.id,
      "INVALID_WORKSPACE",
      "Computer settings belong to a different identity",
    );
    const access: WorkspaceAccess = {
      repository: this.repository,
      handle,
      computer,
      membership: {
        workspaceId: id,
        name: link.name,
        userId: handle.doc()!.ownerId,
        members: {},
      },
    };
    const replica = new Replica(this.identity, access, this.storage);
    try {
      await replica.open(progress);
      invariant(
        replica.member,
        "PERMISSION_DENIED",
        "This identity has no Keyhive access to the workspace",
      );
      if (replica.member.admin)
        await this.repository.enableGroupRelay(handle.doc()!.accessGroup);
    } catch (error) {
      replica.deactivate();
      throw error;
    }
    if (this.repository.relayEnabled) {
      for (const key of replica.ids("vault/")) {
        const value = replica.read<{
          url: AutomergeUrl;
          sender: { id: string };
          revoked: boolean;
        }>(key);
        if (!value || value.revoked || value.sender.id !== this.identity.id)
          continue;
        const secret = await this.repository.repo.find(value.url, {
          signal: AbortSignal.timeout(15000),
        });
        await this.repository.enableRelay(secret);
      }
      await replica.flush();
    }
    const node = new WorkspaceNode(
      replica,
      link,
      () => this.capabilityProvider(),
      handler,
      this.commandHost,
    );
    this.workspaces.set(id, node);
    this.protocols.set(id, node.protocol);
    await node.protocol.announce();
    return node;
  }
  async createWorkspace(
    name: string,
    id: string = crypto.randomUUID(),
    userId = userIdFor(this.identity.id),
    options: { seed?: boolean; defaultSchemaId?: string } = {},
  ) {
    invariant(name.trim(), "INVALID_NAME", "Enter a workspace name");
    const group = await this.repository.createGroup();
    const settings =
      await this.repository.createGrouped<SharedSettingsDocument>(
        {
          format: "jocki-shared-settings",
          workspaceId: id,
          values: {
            "setting/workspace":
              defaultWorkspaceSettings() as unknown as Record<string, unknown>,
          },
        },
        group,
      );
    const handle = await this.repository.createGrouped<WorkspaceDocument>(
      {
        format: "jocki-workspace",
        id,
        name: name.trim(),
        ownerId: userId,
        devices: {
          [this.identity.id]: {
            ...publicIdentity(this.identity),
            contactCard: this.repository.contactCard,
          },
        },
        accessGroup: group,
        defaultSchemaId:
          options.defaultSchemaId ??
          (await schemaResourceId(id, "default-schema")),
        schemas: {},
        sharedSettings: settings.url,
      },
      group,
    );
    this.links.push({ id, name: name.trim(), url: handle.url });
    await this.save();
    const node = await this.workspace(id);
    await node.replica.update(
      "setting/workspace",
      defaultWorkspaceSettings() as unknown as Record<string, unknown>,
    );
    if (options.seed !== false) await node.records.ensureSchema();
    return node;
  }
  pairingRequest(options: DeviceRequestOptions = {}) {
    return JSON.stringify({
      format: "jocki-contact",
      contactCard: this.repository.contactCard,
      identity: {
        ...publicIdentity(this.identity),
        name: options.name ?? this.identity.name,
      },
      access: options.access ?? "write",
      workspaceId: options.workspaceId,
    });
  }
  async approve(id: string, requestText: string) {
    const node = await this.workspace(id),
      request = readDeviceRequest(requestText);
    invariant(
      !request.workspaceId || request.workspaceId === id,
      "INVALID_INVITATION",
      "Contact request names a different workspace",
    );
    invariant(
      node.replica.member.admin,
      "PERMISSION_DENIED",
      "Only a workspace admin can grant access",
    );
    await this.repository.grantGroup(
      node.replica.handle.doc()!.accessGroup,
      request.contactCard,
      request.access === "read" ? "read" : "edit",
    );
    node.replica.handle.change((doc) => {
      doc.devices[request.identity.id] = {
        ...request.identity,
        contactCard: request.contactCard,
      };
    });
    await refreshMembership(node.replica.access);
    await node.replica.flush();
    const invitation: PairingInvitation = {
      format: "jocki-workspace-invitation",
      url: node.link.url,
      workspaceId: id,
      name: node.link.name,
    };
    return JSON.stringify(invitation, null, 2);
  }
  async join(value: string) {
    const invitation = readInvitation(value);
    const added = !this.links.some(
      (link) => link.id === invitation.workspaceId,
    );
    if (added) {
      this.links.push({
        id: invitation.workspaceId,
        url: invitation.url,
        name: invitation.name,
      });
      await this.save();
    }
    try {
      return await this.workspace(invitation.workspaceId);
    } catch (error) {
      if (added && !this.workspaces.has(invitation.workspaceId)) {
        this.links = this.links.filter(
          (link) => link.id !== invitation.workspaceId,
        );
        await this.save();
      }
      throw error;
    }
  }
  async rememberWorkspace(link: LinkedWorkspace) {
    await this.repository.hive.keyhiveStorage.ingestKeyhiveFromStorage(
      this.repository.hive.keyhive,
    );
    if (!this.links.some((saved) => saved.id === link.id)) {
      this.links.push(structuredClone(link));
      await this.save();
    }
    return this.workspace(link.id);
  }
  async revoke(id: string, deviceId: string) {
    const node = await this.workspace(id);
    invariant(
      node.replica.member.admin && deviceId !== this.identity.id,
      "PERMISSION_DENIED",
      "A workspace admin must revoke another identity",
    );
    await node.replica.flush();
    await this.repository.revokeGroup(
      node.replica.handle.doc()!.accessGroup,
      deviceId,
    );
    // Keyhive gives a document's creator a direct grant as well as its parent group.
    // Remove that grant on children this device created while it was approved.
    for (const handle of node.replica.graph.sharedHandles()) {
      const member = (await this.repository.hive.listMembers(handle.url)).find(
        (member) => member.id === deviceId,
      );
      if (member)
        await this.repository.hive.revokeMemberFromDoc(handle.url, deviceId);
    }
    await refreshMembership(node.replica.access);
    await node.replica.flush();
    for (const listener of node.replica.membershipListeners) listener();
  }
  startAutomaticSync(interval = 15000) {
    for (const node of this.workspaces.values())
      node.startAutomaticSync(interval);
  }
  resumeAutomaticSync(id: string) {
    this.workspaces.get(id)?.startAutomaticSync();
  }
  wakeAutomaticSync() {
    for (const node of this.workspaces.values()) node.wakeAutomaticSync();
  }
  async closeWorkspace(id: string) {
    const node = this.workspaces.get(id);
    if (node) await node.stop();
    this.workspaces.delete(id);
    this.protocols.delete(id);
    await this.storage.closeWorkspace?.(id);
  }
  async removeWorkspace(id: string) {
    await this.closeWorkspace(id);
    this.links = this.links.filter((link) => link.id !== id);
    await this.save();
    await this.storage.deleteWorkspace?.(id);
  }
  private closing?: Promise<void>;
  close() {
    return (this.closing ??= (async () => {
      try {
        for (const id of this.workspaces.keys()) await this.closeWorkspace(id);
      } finally {
        try {
          await this.repository.close();
        } finally {
          await this.storage.close?.();
        }
      }
    })());
  }
}
