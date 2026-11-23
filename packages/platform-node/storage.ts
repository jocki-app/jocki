import "./duckdb";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DuckStorage } from "../storage/duckdb";
import { ScopedDuckStorage } from "../storage/scoped";
/** Device-local metadata and rebuildable SQL projections. */
export class FileStorage extends ScopedDuckStorage {
  readonly databaseDirectory: string;
  constructor(readonly directory: string) {
    super();
    this.databaseDirectory = path.join(directory, "projections");
  }
  protected async openScope(scope: string) {
    const directory = this.databaseDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new DuckStorage({
      path: path.join(directory, `${scope}.duckdb`),
    });
  }
  protected async scopes() {
    await mkdir(this.databaseDirectory, { recursive: true, mode: 0o700 });
    return [
      "device",
      ...(await readdir(this.databaseDirectory))
        .filter((name) => name.endsWith(".duckdb") && name !== "device.duckdb")
        .map((name) => name.slice(0, -7)),
    ];
  }
  protected async removeScope(scope: string) {
    for (const suffix of ["", ".wal", ".wal.checkpoint", ".wal.recovery"])
      await rm(path.join(this.databaseDirectory, `${scope}.duckdb${suffix}`), {
        force: true,
      });
  }
}
