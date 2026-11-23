import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import type { DatabaseWorkingStorage } from "../storage/database";
import { setDatabaseWorkingStorage } from "./duckdb";
import path from "node:path";
async function atomicSettingsWrite(filename: string, bytes: Uint8Array) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + "." + crypto.randomUUID() + ".tmp";
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, filename);
}

/** Local app preference, deliberately excluded from workspace files and peer sync. */
export class DatabaseSettings {
  private mode: DatabaseWorkingStorage = "disk";
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private filename: string) {}
  static async open(filename: string) {
    const settings = new DatabaseSettings(filename);
    try {
      const saved = JSON.parse(await readFile(filename, "utf8"));
      if (saved?.workingStorage === "memory") settings.mode = "memory";
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
    }
    setDatabaseWorkingStorage(settings.mode);
    return settings;
  }
  get() {
    return this.mode;
  }
  set(value: unknown): Promise<DatabaseWorkingStorage> {
    if (value !== "disk" && value !== "memory")
      return Promise.reject(Error("Choose disk or memory database storage"));
    const next = this.queue.then(async () => {
      await atomicSettingsWrite(
        this.filename,
        new TextEncoder().encode(JSON.stringify({ workingStorage: value })),
      );
      setDatabaseWorkingStorage(value);
      this.mode = value;
      return value;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
