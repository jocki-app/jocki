import { CoreError } from "@jocki/platform/core/errors";

export interface SyncContext {
  phase: string;
  workspaceId?: string;
  peer?: string;
  operation?: string;
  attempt?: number;
  elapsedMs?: number;
  operationId?: string;
  generation?: string;
  lifecycle?: string;
  documentId?: string;
}
export interface SyncDiagnostic {
  id: string;
  at: string;
  context: SyncContext;
  error: object;
  disposition: "retry" | "pending" | "failure";
}
const diagnostics = new Map<string, SyncDiagnostic>();
const listeners = new Set<(diagnostic: SyncDiagnostic) => void>();
export const syncDiagnostics = () => [...diagnostics.values()];
export function subscribeSyncErrors(
  listener: (diagnostic: SyncDiagnostic) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function diagnosticContext(context: SyncContext): SyncContext {
  return Object.fromEntries(
    Object.entries(context)
      .filter(([key, value]) =>
        [
          "phase",
          "workspaceId",
          "peer",
          "operation",
          "operationId",
          "generation",
          "lifecycle",
          "documentId",
        ].includes(key)
          ? typeof value === "string"
          : ["attempt", "elapsedMs"].includes(key) &&
            typeof value === "number" &&
            Number.isFinite(value),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? safeText(value) : value,
      ]),
  ) as unknown as SyncContext;
}
/** Private owner snapshots carry only these bounded, already redacted diagnostics. */
export function publishSyncDiagnostic(entry: SyncDiagnostic) {
  if (
    !entry ||
    !/^[a-f0-9-]{36}$/.test(entry.id) ||
    typeof entry.at !== "string" ||
    !entry.context ||
    typeof entry.context.phase !== "string" ||
    diagnostics.has(entry.id)
  )
    return false;
  const diagnostic: SyncDiagnostic = {
    id: entry.id,
    at: safeText(entry.at),
    context: diagnosticContext(entry.context),
    error: describe(entry.error),
    disposition: errorDisposition(entry.error),
  };
  diagnostics.set(entry.id, diagnostic);
  if (diagnostics.size > 50)
    diagnostics.delete(diagnostics.keys().next().value!);
  for (const listener of listeners) {
    try {
      listener(diagnostic);
    } catch {
      /* Diagnostics must not fail writes. */
    }
  }
  return true;
}
function fields(value: unknown): Record<string, any> {
  return value && typeof value === "object"
    ? (value as Record<string, any>)
    : {};
}
const disconnected = new Set([
  "ConnectionClosedError",
  "MuxerClosedError",
  "StreamResetError",
  "StreamAbortedError",
  "StreamClosedError",
  "UnexpectedEOFError",
  "AbortError",
  "TimeoutError",
]);
/** Log descriptions and call sites, never request bodies, command arguments or error objects. */
export function safeErrorText(value: string) {
  return value
    .slice(0, 4000)
    .split("\n")[0]
    .replace(/\{.*$/, "[structured data omitted]")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "[quoted value omitted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(password|token|secret|authorization|invitation|ciphertext|privateKey)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9+/_=-]{80,}/g, "[encoded data omitted]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .slice(0, 500);
}
const safeText = safeErrorText;
function databaseFailure(
  error: unknown,
): { type: string; message: string } | undefined {
  const message = typeof error === "string" ? error : fields(error).message;
  if (typeof message !== "string") return;
  if (/^Out of Memory Error:/i.test(message))
    return { type: "Out of Memory", message: safeText(message) };
  if (message.length > 65536 || !message.startsWith("{")) return;
  try {
    const value = JSON.parse(message);
    // DuckDB-Wasm's Arrow API returns structured exception strings. Interpret
    // only its error description, never dump its SQL, parameters or object.
    if (
      typeof value.exception_type === "string" &&
      typeof value.exception_message === "string"
    )
      return {
        type: value.exception_type,
        message: safeText(
          `${value.exception_type} Error: ${value.exception_message}`,
        ),
      };
  } catch {
    /* Not a structured database exception. */
  }
}
/** WebKit, native plugins and WebSockets can reject with plain objects or Events. */
export function syncErrorMessage(error: unknown, depth = 0): string {
  const database = databaseFailure(error);
  if (database) return database.message;
  if (typeof error === "string") return safeText(error);
  const value = fields(error);
  if (typeof value.message === "string" && value.message.trim())
    return safeText(value.message);
  if (depth < 3 && Array.isArray(value.errors) && value.errors.length)
    return value.errors
      .slice(0, 4)
      .map((item: unknown) => syncErrorMessage(item, depth + 1))
      .join("; ");
  if (depth < 3 && value.cause) return syncErrorMessage(value.cause, depth + 1);
  if (typeof value.type === "string")
    return `Network event: ${safeText(value.type)}`;
  if (typeof value.name === "string") return safeText(value.name);
  return error == null
    ? "The operation failed without an error value"
    : `The operation failed (${typeof error})`;
}
export function syncErrorKind(error: unknown, depth = 0): string {
  if (depth >= 4) return "SYNC_FAILED";
  if (databaseFailure(error)?.type === "Out of Memory")
    return "RESOURCE_EXHAUSTED";
  if (error && typeof error === "object") {
    const kind =
      (error as { kind?: unknown; code?: unknown }).kind ??
      (error as { code?: unknown }).code;
    if (typeof kind === "string" && /^[A-Z0-9_]{1,64}$/.test(kind)) return kind;
    if (Array.isArray(fields(error).errors)) {
      const errors: unknown[] = fields(error).errors;
      if (errors.length > 32) return "SYNC_BATCH_FAILED";
      const kinds = errors.map((item) => syncErrorKind(item, depth + 1));
      if (
        kinds.length &&
        kinds.every((kind) =>
          ["PEER_OFFLINE", "PEER_DISCONNECTED", "PEER_CONNECT_FAILED"].includes(
            kind,
          ),
        )
      )
        return "PEER_DISCONNECTED";
      return "SYNC_BATCH_FAILED";
    }
  }
  return "SYNC_FAILED";
}
export const isPeerOffline = (error: unknown) =>
  ["PEER_OFFLINE", "PEER_DISCONNECTED", "PEER_CONNECT_FAILED"].includes(
    syncErrorKind(error),
  );
/** Expected state is recorded for debugging but is not a user-facing failure. */
export function errorDisposition(
  error: unknown,
): SyncDiagnostic["disposition"] {
  if (isPeerOffline(error)) return "retry";
  if (
    [
      "BUSY",
      "COPY_PENDING",
      "OFFLINE_UNAVAILABLE",
      "WORKSPACE_CLOSED",
      "DEVICE_CLOSED",
      "SYNC_NOT_STABLE",
      "SYNC_CONSUMER_PENDING",
      "GC_CHANGED",
      "MEMBERSHIP_RESPONSE",
      "MEMBERSHIP_UPDATED",
    ].includes(syncErrorKind(error))
  )
    return "pending";
  return "failure";
}
function describe(error: unknown, depth = 0): object {
  const value = fields(error);
  const stack: string[] =
    typeof value.stack === "string"
      ? value.stack.split("\n")
      : Array.isArray(value.stack)
        ? value.stack
            .filter((line: unknown) => typeof line === "string")
            .slice(0, 10)
        : [];
  return {
    name: safeText(typeof value.name === "string" ? value.name : typeof error),
    kind: syncErrorKind(error),
    message: syncErrorMessage(error),
    ...(typeof value.type === "string" ? { type: safeText(value.type) } : {}),
    stack: stack
      .filter((line) => /^\s*at\s|^[^\s@]+@/.test(line))
      .slice(0, 10)
      .map(safeText),
    ...(depth < 3 && value.cause
      ? { cause: describe(value.cause, depth + 1) }
      : {}),
    ...(depth < 3 && Array.isArray(value.errors)
      ? {
          errors: value.errors
            .slice(0, 4)
            .map((item: unknown) => describe(item, depth + 1)),
        }
      : {}),
  };
}
export class SyncError extends CoreError {
  readonly diagnosticId: string;
  readonly diagnostic: SyncDiagnostic;
  constructor(error: unknown, context: SyncContext) {
    const kind = syncErrorKind(error),
      message = syncErrorMessage(error);
    // Serialized errors already carry their first failing boundary. Do not
    // prepend peer-request again every time one crosses the owner bridge.
    const inherited = fields(error).diagnosticId;
    super(
      kind,
      inherited && /^[a-f0-9-]{36}$/.test(inherited)
        ? message
        : `${context.phase} [${kind}]: ${message}`,
    );
    this.name = "SyncError";
    this.cause = error;
    const inheritedId = (error as { diagnosticId?: string } | null)
      ?.diagnosticId;
    this.diagnosticId =
      inheritedId && /^[a-f0-9-]{36}$/.test(inheritedId)
        ? inheritedId
        : crypto.randomUUID();
    const original = fields(error).diagnostic as SyncDiagnostic | undefined;
    this.diagnostic =
      original?.id === this.diagnosticId &&
      typeof original.at === "string" &&
      typeof original.context?.phase === "string"
        ? {
            id: original.id,
            at: safeText(original.at),
            context: diagnosticContext(original.context),
            error: describe(original.error),
            disposition: errorDisposition(original.error),
          }
        : {
            id: this.diagnosticId,
            at: new Date().toISOString(),
            context: diagnosticContext(context),
            error: describe(error),
            disposition: errorDisposition(error),
          };
  }
}
const printed = new WeakSet<SyncError>();
/** Preserve the first failing boundary and its cause when higher layers also handle it. */
export function reportSyncError(
  error: unknown,
  context: SyncContext,
): SyncError {
  const failure =
    error instanceof SyncError ? error : new SyncError(error, context);
  if (!printed.has(failure)) {
    printed.add(failure);
    const first = publishSyncDiagnostic(failure.diagnostic);
    const message = "[Jocki sync] " + JSON.stringify(failure.diagnostic);
    try {
      if (first) {
        if (failure.diagnostic.disposition === "retry") console.warn(message);
        else if (failure.diagnostic.disposition === "pending")
          console.info(message);
        else console.error(message);
      }
    } catch {
      /* Diagnostics cannot interrupt durable work. */
    }
  }
  return failure;
}
/** Check only transport causes, with bounded recursion. An authorization or
 * integrity error inside a batch must never be reclassified as connectivity. */
function transportUnavailable(error: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  const value = fields(error);
  if (isPeerOffline(error)) return true;
  if (
    typeof value.kind === "string" &&
    !["SYNC_FAILED", "SYNC_BATCH_FAILED"].includes(value.kind)
  )
    return false;
  if (
    disconnected.has(value.name) ||
    ["NoValidAddressesError", "ConnectionFailedError"].includes(value.name) ||
    ["error", "close"].includes(value.type)
  )
    return true;
  if (
    value.name === "OperationError" &&
    /(?:datachannel|sctp|connection.*clos|not open)/i.test(value.message ?? "")
  )
    return true;
  if (
    value.name === "StreamStateError" &&
    /(?:stream.*clos|stream.*reset|not open)/i.test(value.message ?? "")
  )
    return true;
  if (Array.isArray(value.errors))
    return (
      value.errors.length > 0 &&
      value.errors.length <= 32 &&
      value.errors.every((cause: unknown) =>
        transportUnavailable(cause, depth + 1),
      )
    );
  return value.cause
    ? transportUnavailable(value.cause, depth + 1)
    : value.diagnostic?.error
      ? transportUnavailable(value.diagnostic.error, depth + 1)
      : false;
}
/** Normalize before publication, including errors that crossed a local bridge. */
export function reportTransportError(error: unknown, context: SyncContext) {
  if (!isPeerOffline(error) && transportUnavailable(error)) {
    const failure = new CoreError(
      context.phase === "connect" ? "PEER_CONNECT_FAILED" : "PEER_DISCONNECTED",
      context.phase === "connect"
        ? "Could not connect to this peer. Check its address, that the other app is running, and that both devices can reach the same network."
        : "Peer disconnected; waiting to reconnect",
    );
    failure.cause = error;
    return reportSyncError(failure, context);
  }
  return reportSyncError(error, context);
}
