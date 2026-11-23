/** The portable database contract. Platform adapters provide the DuckDB runtime and files. */
export type SqlValue = string | number | boolean | null;
export type SqlRow = Record<string, unknown>;
export type DatabaseWorkingStorage = "disk" | "memory";
/** Closing a view is a normal subscription lifecycle event, not a query failure. */
export class DatabaseClosedError extends Error {
  constructor() {
    super("Database is closed");
    this.name = "DatabaseClosedError";
  }
}
export interface SqlConnection {
  query<T extends SqlRow = SqlRow>(
    sql: string,
    values?: SqlValue[],
  ): Promise<T[]>;
}
export interface DuckDriver extends SqlConnection {
  checkpoint(): Promise<void>;
  export(): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface DatabaseOptions {
  /** An app-private database; names are never interpreted as paths. */
  name?: string;
  /** Native adapters may open a user-authorized file directly. */
  path?: string;
  /** Import into a private, temporary database. Never modifies the input bytes. */
  bytes?: Uint8Array;
  /** Temporary working storage. Memory is mandatory for decrypted workspace data. */
  workingStorage?: DatabaseWorkingStorage;
}
export interface DatabasePlatform {
  open(options: DatabaseOptions): Promise<DuckDriver>;
  names(): Promise<string[]>;
  remove(name: string): Promise<void>;
  /** Atomically replace a closed named/path database with a compact image. */
  replace?(options: DatabaseOptions, bytes: Uint8Array): Promise<void>;
}
let platform: DatabasePlatform | undefined;
export function configureDatabase(value: DatabasePlatform) {
  platform = value;
}
export const databaseConfigured = () => Boolean(platform);
export function databasePlatform() {
  if (!platform) throw Error("Initialize the DuckDB platform adapter first");
  return platform;
}
export const duckdbFile = (bytes: Uint8Array) =>
  bytes.length >= 16 && String.fromCharCode(...bytes.slice(8, 12)) === "DUCK";
export const identifier = (value: string) =>
  '"' + value.replaceAll('"', '""') + '"';
export const literal = (value: string) =>
  "'" + value.replaceAll("'", "''") + "'";

/** One queue owns each connection. Transactions expose their own client to prevent interleaving. */
export class SqlDatabase implements SqlConnection {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failure?: unknown;
  private constructor(readonly driver: DuckDriver) {}
  static async open(options: DatabaseOptions = {}) {
    if (options.bytes && !duckdbFile(options.bytes))
      throw Error(
        "Choose a DuckDB workspace file. Previous workspace formats are not supported.",
      );
    const driver = await databasePlatform().open(options);
    const database = new SqlDatabase(driver);
    try {
      await driver.query(
        "SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET enable_external_access = false",
      );
      return database;
    } catch (error) {
      await driver.close();
      throw error;
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new DatabaseClosedError());
    const result = this.queue.then(() => {
      if (this.failure) throw this.failure;
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  query<T extends SqlRow = SqlRow>(sql: string, values: SqlValue[] = []) {
    return this.serial(() => this.driver.query<T>(sql, values));
  }
  transaction<T>(work: (connection: SqlConnection) => Promise<T>) {
    return this.serial(async () => {
      await this.driver.query("BEGIN TRANSACTION");
      let committed = false;
      try {
        const result = await work(this.driver);
        await this.driver.query("COMMIT");
        committed = true;
        await this.driver.checkpoint();
        return result;
      } catch (error) {
        if (!committed) await this.driver.query("ROLLBACK").catch(() => {});
        else
          this.failure = Error(
            "Database persistence failed. Close and reopen before continuing.",
            { cause: error },
          );
        throw error;
      }
    });
  }
  export() {
    return this.serial(() => this.driver.export());
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.driver.close();
  }
}
