import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { NodeFileRuntime } from "../packages/platform-node/file-runtime";

it("watches externally saved files, infers edited moves and reopens the same workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jocki-file-runtime-")),
    directory = path.join(root, "app"),
    folder = path.join(root, "vault"),
    errors: unknown[] = [];
  let runtime: NodeFileRuntime | undefined;
  try {
    await mkdir(folder);
    const original = Array.from(
      { length: 50 },
      (_, i) => `Line ${i}: the shared document has many stable words.\n`,
    ).join("");
    await writeFile(path.join(folder, "note.md"), original);
    runtime = await NodeFileRuntime.open({
      directory,
      vaults: [folder],
      intervalMs: 3600000,
      onError: (e) => errors.push(e),
    });
    const workspace = runtime.workspace.current.id,
      computer = runtime.computer,
      vault = [...runtime.vaults.values()][0],
      id = vault.list()[0].id;
    await vault.configure({ history: true });
    await rename(
      path.join(folder, "note.md"),
      path.join(folder, "Moved 🦖.md"),
    );
    await writeFile(
      path.join(folder, "Moved 🦖.md"),
      original + "External editor saved this.\n",
    );
    await expect
      .poll(() => vault.list()[0]?.path, { timeout: 7000 })
      .toBe("Moved 🦖.md")
      .catch((error) => {
        console.error("Watch errors", errors);
        throw error;
      });
    expect(vault.list()[0].id).toBe(id);
    await expect
      .poll(() => vault.doc(id).text, { timeout: 7000 })
      .toContain("External editor saved this.");
    await expect
      .poll(() => runtime!.search.search("External").length, { timeout: 7000 })
      .toBe(1);
    expect(
      await readFile(path.join(directory, "workspace/workspace.json"), "utf8"),
    ).toContain(workspace);
    await runtime.close();
    runtime = await NodeFileRuntime.open({
      directory,
      intervalMs: 3600000,
      onError: (e) => errors.push(e),
    });
    expect(runtime.workspace.current.id).toBe(workspace);
    expect(runtime.computer).toBe(computer);
    expect([...runtime.vaults.values()][0].list()[0].id).toBe(id);
    expect(errors).toEqual([]);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
