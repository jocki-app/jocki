import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  defaultRepositorySettings,
  validateRepositorySettings,
} from "../core/relay-settings";

export async function readRepositorySettings(directory: string) {
  try {
    return validateRepositorySettings(
      JSON.parse(
        await readFile(
          path.join(directory, "repository-settings.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return defaultRepositorySettings();
    throw error;
  }
}
export async function writeRepositorySettings(
  directory: string,
  input: unknown,
) {
  const value = validateRepositorySettings(input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    ".repository-settings-" + crypto.randomUUID(),
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path.join(directory, "repository-settings.json"));
    const folder = await open(directory, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return value;
}
