import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
async function processAlive(pid: number) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (process.platform !== "darwin" && process.platform !== "linux")
    return true;
  // kill(pid, 0) also succeeds for unreaped children, although they no longer
  // have open files or execute code. A failed status query must stay conservative.
  return new Promise<boolean>((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "stat="],
      { encoding: "utf8", timeout: 1000 },
      (error, stdout) =>
        resolve(Boolean(error) || !stdout.trim().startsWith("Z")),
    );
  });
}
/** One writer per native data directory. Management commands use the same lock. */
export async function lockDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return lockFile(path.join(directory, "runtime.lock"));
}
/** A temporary sidecar lease is device-local and never part of the workspace. */
export async function lockFile(file: string) {
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, host: os.hostname(), token }),
        { flag: "wx", mode: 0o600 },
      );
      return async () => {
        try {
          if (JSON.parse(await readFile(file, "utf8")).token === token)
            await rm(file);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = JSON.parse(await readFile(file, "utf8"));
      const alive =
        previous.host !== os.hostname() || (await processAlive(previous.pid));
      if (alive)
        throw Error(
          "This data directory is already open. Stop its Jocki process before running a management command.",
        );
      // A status probe can overlap another recovery. Never remove its new lease.
      if (JSON.parse(await readFile(file, "utf8")).token !== previous.token)
        continue;
      await rm(file);
    }
  }
  throw Error("Could not exclusively open the data directory");
}
