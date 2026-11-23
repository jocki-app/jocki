import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSettings } from "../packages/platform-node/database-settings";
import { setDatabaseWorkingStorage } from "../packages/platform-node/duckdb";
import { SqlDatabase } from "../packages/storage/database";

afterEach(() => {
  setDatabaseWorkingStorage("disk");
  vi.restoreAllMocks();
});

it("defaults to private disk storage, spills larger work, exports and removes the working files", async () => {
  const db = await SqlDatabase.open();
  let workingPath = "";
  let image: Uint8Array;
  try {
    const [database] = await db.query<{ path: string }>(
      "SELECT path FROM duckdb_databases() WHERE NOT internal",
    );
    workingPath = database.path;
    expect(isAbsolute(workingPath)).toBe(true);
    expect((await stat(dirname(workingPath))).mode & 0o777).toBe(0o700);
    await db.query("SET memory_limit='32MB'; SET threads=1");
    const [settings] = await db.query<{ spill: string }>(
      "SELECT current_setting('temp_directory') AS spill",
    );
    expect(await realpath(dirname(settings.spill))).toBe(dirname(workingPath));
    // Sorting 5 million key/value pairs exceeds the 32 MB working budget.
    expect(
      await db.query(
        "SELECT sum(i)::VARCHAR AS total FROM (SELECT i FROM range(5000000) t(i) ORDER BY hash(i))",
      ),
    ).toEqual([{ total: "12499997500000" }]);
    await db.transaction((sql) =>
      sql.query("CREATE TABLE saved AS SELECT 'durable' AS value"),
    );
    image = await db.export();
  } finally {
    await db.close();
  }
  await expect(stat(dirname(workingPath))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const reopened = await SqlDatabase.open({ bytes: image! });
  try {
    expect(await reopened.query("SELECT * FROM saved")).toEqual([
      { value: "durable" },
    ]);
  } finally {
    await reopened.close();
  }
});

it("persists only the local storage preference, validates input and leaves it unchanged on write failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "jocki-db-settings-"));
  const folder = join(root, "preferences"),
    filename = join(folder, "database-settings.json");
  try {
    let settings = await DatabaseSettings.open(filename);
    expect(settings.get()).toBe("disk");
    await settings.set("memory");
    settings = await DatabaseSettings.open(filename);
    expect(settings.get()).toBe("memory");
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({
      workingStorage: "memory",
    });
    const db = await SqlDatabase.open();
    try {
      expect(
        await db.query(
          "SELECT path FROM duckdb_databases() WHERE NOT internal",
        ),
      ).toEqual([{ path: "workspace.duckdb" }]);
    } finally {
      await db.close();
    }
    await expect(settings.set("/arbitrary/path")).rejects.toThrow(
      "Choose disk or memory",
    );
    await rm(folder, { recursive: true });
    await writeFile(folder, "blocked");
    await expect(settings.set("disk")).rejects.toThrow();
    expect(settings.get()).toBe("memory");
    await rm(folder);
    await settings.set("disk");
    expect((await DatabaseSettings.open(filename)).get()).toBe("disk");
    expect(await readdir(folder)).toEqual(["database-settings.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
