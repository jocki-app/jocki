import {
  configureSync,
  getLogger,
  type LogRecord,
  type LogLevel,
} from "@logtape/logtape";
import type { VaultFileSystem } from "./vaults/contracts";
import { text, utf8 } from "./crypto";

export const logRetentionDays = 14;
const maxDayBytes = 2 * 1024 * 1024;
export interface LocalLogRecord {
  id: string;
  time: number;
  level: LogLevel;
  category: string;
  message: string;
}
const observers = new Set<(record: LocalLogRecord) => void>();
const pendingErrors: LocalLogRecord[] = [];
let activeStore: LocalLogStore | undefined;
/** One app-level feed; platform UI decides how diagnostic levels are displayed. */
export function subscribeLocalLogs(listener: (record: LocalLogRecord) => void) {
  observers.add(listener);
  return () => {
    observers.delete(listener);
  };
}
export function redactLog(value: unknown): string {
  const raw =
    value instanceof Error
      ? `${value.name}: ${value.message}\n${value.stack ?? ""}`
      : String(value);
  return raw
    .replace(
      /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
      "[private key redacted]",
    )
    .replace(
      /("?(?:password|secret|token|authorization|contactCard|invitation|privateKey)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\s,}]+)/gi,
      "$1[redacted]",
    )
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/automerge:[a-zA-Z0-9]+/g, "automerge:[redacted]")
    .replace(
      /jocki:\/\/share\/[A-Za-z0-9_-]+/g,
      "saddle://share/[redacted]",
    )
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, "$1[query redacted]")
    .slice(0, 8000);
}
/** Local, bounded JSON-lines diagnostics. Never a replicated document or vault file. */
export class LocalLogStore {
  private lastPruned = "";
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(record: LocalLogRecord) => void>();
  private constructor(
    readonly storage: VaultFileSystem,
    private now: () => number,
  ) {}
  static async open(storage: VaultFileSystem, now = Date.now) {
    const store = new LocalLogStore(storage, now);
    await store.prune();
    return store;
  }
  configure() {
    activeStore = this;
    configureSync({
      reset: true,
      sinks: {
        local: (record: LogRecord) => {
          void this.record(record);
        },
      },
      loggers: [
        { category: ["jocki"], lowestLevel: "info", sinks: ["local"] },
        {
          category: ["logtape", "meta"],
          lowestLevel: "error",
          sinks: ["local"],
        },
      ],
    });
    for (const record of pendingErrors.splice(0)) void this.append(record);
  }
  unconfigure() {
    if (activeStore !== this) return;
    activeStore = undefined;
    configureSync({ reset: true, sinks: {}, loggers: [] });
    this.listeners.clear();
  }
  subscribe(listener: (record: LocalLogRecord) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private record(record: LogRecord) {
    return this.append({
      id: crypto.randomUUID(),
      time: record.timestamp,
      level: record.level,
      category: record.category.join("."),
      message: redactLog(
        record.message
          .map((v) => (typeof v === "string" ? v : redactLog(v)))
          .join(""),
      ),
    });
  }
  append(record: LocalLogRecord) {
    const safe = {
      ...record,
      message: redactLog(record.message),
      category: record.category.slice(0, 200),
    };
    const pending = this.queue.then(async () => {
      await this.prune();
      const path =
        "logs/" + new Date(safe.time).toISOString().slice(0, 10) + ".jsonl";
      let existing = text.decode(
        (await this.storage.read(path)) ?? new Uint8Array(),
      );
      const next = JSON.stringify(safe) + "\n";
      if (utf8.encode(existing + next).byteLength > maxDayBytes) {
        existing = existing.slice(Math.floor(existing.length / 2));
        existing = existing.slice(existing.indexOf("\n") + 1);
      }
      await this.storage.writeAtomic(path, utf8.encode(existing + next));
    });
    // Diagnostics cannot make editing fail or recursively log storage failures.
    this.queue = pending.catch(() => {});
    this.listeners.forEach((fn) => fn(safe));
    observers.forEach((fn) => fn(safe));
    return this.queue.then(() => {});
  }
  private async prune() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.lastPruned === day) return;
    const cutoff = new Date(this.now() - logRetentionDays * 86400000)
      .toISOString()
      .slice(0, 10);
    for (const path of await this.storage.list()) {
      const match = /^logs\/(\d{4}-\d\d-\d\d)\.jsonl$/.exec(path);
      if (match && match[1] < cutoff) await this.storage.remove(path);
    }
    this.lastPruned = day;
  }
  async list() {
    await this.queue;
    await this.prune();
    const rows: LocalLogRecord[] = [];
    for (const path of (await this.storage.list())
      .filter((p) => /^logs\/\d{4}-\d\d-\d\d\.jsonl$/.test(p))
      .sort()
      .reverse()) {
      for (const line of text
        .decode((await this.storage.read(path)) ?? new Uint8Array())
        .trim()
        .split("\n")) {
        try {
          const row = JSON.parse(line) as LocalLogRecord;
          if (typeof row.message === "string" && Number.isFinite(row.time))
            rows.push(row);
        } catch {}
      }
      if (rows.length >= 10000) break;
    }
    return rows.sort((a, b) => b.time - a.time).slice(0, 10000);
  }
  async clear() {
    await this.queue;
    for (const path of await this.storage.list())
      if (/^logs\/\d{4}-\d\d-\d\d\.jsonl$/.test(path))
        await this.storage.remove(path);
  }
  flush() {
    return this.queue.then(() => {});
  }
}
export const logger = (category: string) => getLogger(["jocki", category]);
export function logError(error: unknown, category = "app") {
  if (error !== "" && activeStore)
    logger(category).error("{error}", { error: redactLog(error) });
  else if (error !== "") {
    const record: LocalLogRecord = {
      id: crypto.randomUUID(),
      time: Date.now(),
      level: "error",
      category: "jocki." + category,
      message: redactLog(error),
    };
    pendingErrors.push(record);
    if (pendingErrors.length > 100) pendingErrors.shift();
    observers.forEach((fn) => fn(record));
  }
}
