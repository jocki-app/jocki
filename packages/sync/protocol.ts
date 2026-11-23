import { Signed, uint8ArrayToHex } from "@automerge/automerge-repo-keyhive";
import type { DocHandleEphemeralMessagePayload } from "@automerge/automerge-repo";
import type { Replica } from "../core/replica";
import { ReplicaFiles } from "../core/files";
import { canonical, utf8, text, base64, unbase64 } from "../core/crypto";
import { refreshMembership } from "../core/membership";
import { invariant } from "@jocki/platform/core/errors";
import { LocalState } from "../core/local-state";
export type CommandHandler = (
  command: string,
  input: unknown,
  context: { deviceId: string; requestId: string },
) => Promise<unknown>;
interface Message {
  workspaceId: string;
  id: string;
  issuedAt: number;
  target: string;
  kind: "request" | "reply" | "presence";
  command?: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  name?: string;
  capabilities?: string[];
}
/** Live command channel, separate from document replication. Keyhive verifies the sender. */
export class PeerProtocol {
  readonly files: ReplicaFiles;
  readonly connections = new Set<
    (id: string, info: { name: string; capabilities: string[] }) => void
  >();
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      target: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private commands: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    readonly replica: Replica,
    readonly capabilities: () => string[] = () => [],
    private execute?: CommandHandler,
    private readonly commandHost = true,
  ) {
    this.files = new ReplicaFiles(replica);
    replica.handle.on("ephemeral-message", this.receive);
  }
  setHandler(handler: CommandHandler) {
    this.execute = handler;
  }
  private async send(message: Message) {
    const signed = await this.replica.access.repository.hive.keyhive.trySign(
      utf8.encode(canonical(message)),
    );
    this.replica.handle.broadcast({
      jocki: "command",
      signed: base64(signed.toBytes()),
    });
  }
  private receive = ({
    message,
  }: DocHandleEphemeralMessagePayload<unknown>) => {
    void this.receiveMessage(message).catch((error) => {
      this.replica.error = String(error);
    });
  };
  private async receiveMessage(input: unknown) {
    if (this.closed || !input || typeof input !== "object") return;
    const envelope = input as { jocki?: string; signed?: string };
    if (
      envelope.jocki !== "command" ||
      typeof envelope.signed !== "string" ||
      envelope.signed.length > 3 * 1024 * 1024
    )
      return;
    const signed = Signed.fromBytes(unbase64(envelope.signed));
    invariant(
      signed.verify(),
      "INVALID_SIGNATURE",
      "Command signature is invalid",
    );
    const sender = uint8ArrayToHex(signed.verifyingKey),
      message = JSON.parse(text.decode(signed.payload())) as Message;
    if (
      message.workspaceId !== this.replica.workspaceId ||
      Math.abs(Date.now() - message.issuedAt) > 30000 ||
      (message.target !== "*" && message.target !== this.replica.identity.id)
    )
      return;
    await refreshMembership(this.replica.access);
    const member = this.replica.access.membership.members[sender];
    invariant(
      member,
      "PERMISSION_DENIED",
      "Command sender has no workspace access",
    );
    if (message.kind === "presence") {
      for (const listener of this.connections)
        listener(sender, {
          name: member.identity.name,
          capabilities: message.capabilities ?? [],
        });
      return;
    }
    if (message.kind === "reply") {
      const pending = this.pending.get(message.id);
      if (!pending || sender !== pending.target) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.kind !== "request" || !message.command || !this.commandHost)
      return;
    try {
      const result = await this.run(
        message.command,
        message.input,
        sender,
        message.id,
      );
      await this.send({
        workspaceId: this.replica.workspaceId,
        id: message.id,
        target: sender,
        issuedAt: Date.now(),
        kind: "reply",
        result: result ?? null,
      });
    } catch (error) {
      await this.send({
        workspaceId: this.replica.workspaceId,
        id: message.id,
        target: sender,
        issuedAt: Date.now(),
        kind: "reply",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async announce() {
    if (!this.commandHost) return;
    await this.send({
      workspaceId: this.replica.workspaceId,
      id: crypto.randomUUID(),
      target: "*",
      issuedAt: Date.now(),
      kind: "presence",
      capabilities: this.capabilities(),
    });
  }
  private run(
    command: string,
    input: unknown,
    deviceId: string,
    requestId: string,
  ) {
    invariant(
      !this.closed && this.execute,
      "CAPABILITY_UNSUPPORTED",
      "Command execution is unavailable",
    );
    invariant(
      this.replica.access.membership.members[deviceId]?.access === "write" ||
        command === "core.plugins.status",
      "PERMISSION_DENIED",
      "Read-only devices cannot execute commands",
    );
    invariant(
      /^[a-zA-Z0-9_.:-]{1,256}$/.test(requestId),
      "INVALID_COMMAND",
      "Invalid command identifier",
    );
    if (
      command === "core.plugins.status" ||
      (command.startsWith("terminal.") && command !== "terminal.open")
    )
      return this.execute(command, input, { deviceId, requestId });
    const work = this.commands.then(async () => {
      const store = new LocalState(this.replica, "command-receipts"),
        key = deviceId + "." + requestId;
      const fingerprint = canonical({ command, input: input ?? null });
      const previous = await store.get<{
        fingerprint: string;
        result: unknown;
      }>(key);
      if (previous) {
        invariant(
          previous.fingerprint === fingerprint,
          "IDEMPOTENCY_CONFLICT",
          "Command identifier was reused",
        );
        return previous.result;
      }
      const result = await this.execute!(command, input, {
        deviceId,
        requestId,
      });
      await store.set(key, { fingerprint, result: result ?? null });
      return result;
    });
    this.commands = work.catch(() => {});
    return work;
  }
  async localCall(
    command: string,
    input: unknown,
    requestId: string = crypto.randomUUID(),
  ) {
    return this.run(command, input, this.replica.identity.id, requestId);
  }
  async call(command: string, input: unknown, target: string, id: string) {
    invariant(!this.closed, "WORKSPACE_CLOSED", "Workspace is closed");
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Selected device did not answer"));
      }, 30000);
      this.pending.set(id, { resolve, reject, target, timer });
    });
    try {
      await this.send({
        workspaceId: this.replica.workspaceId,
        id,
        target,
        issuedAt: Date.now(),
        kind: "request",
        command,
        input,
      });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error as Error);
      }
    }
    return result;
  }
  async close() {
    this.closed = true;
    this.replica.handle.off("ephemeral-message", this.receive);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Workspace is closed"));
    }
    this.pending.clear();
    await this.commands;
  }
}
