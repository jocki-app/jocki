import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.resolve("scripts/build-vault-native.mjs");

it.each([
  { name: "recovers a missing cached checkout", missing: true },
  { name: "preserves an existing cached checkout", missing: false },
  {
    name: "honors an explicit replacement checkout",
    missing: true,
    explicit: "valid",
  },
  {
    name: "reports an explicitly supplied missing checkout",
    missing: true,
    explicit: "missing",
  },
])("$name", async ({ missing, explicit }) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "jocki-native-build-"),
  );
  const source = path.join(directory, "native/renames");
  const cached = path.join(directory, "cached libgit2");
  const replacement = path.join(directory, "replacement libgit2");
  const build = path.join(directory, "build/native-renames");
  const checkout = async (location: string, label: string) => {
    await mkdir(location, { recursive: true });
    await writeFile(
      path.join(location, "CMakeLists.txt"),
      `file(WRITE "\${CMAKE_BINARY_DIR}/selected-libgit2.txt" "${label}")\n`,
    );
  };
  try {
    await checkout(path.join(source, "libgit2"), "default");
    await checkout(cached, "cached");
    if (explicit === "valid") await checkout(replacement, "replacement");
    await writeFile(
      path.join(source, "CMakeLists.txt"),
      `cmake_minimum_required(VERSION 3.24)
project(native_build_fixture LANGUAGES C)
include(FetchContent)
FetchContent_Declare(libgit2 SOURCE_DIR "\${CMAKE_CURRENT_SOURCE_DIR}/libgit2")
FetchContent_MakeAvailable(libgit2)
add_executable(jocki-renames main.c)
`,
    );
    await writeFile(
      path.join(source, "main.c"),
      "int main(void) { return 0; }\n",
    );
    const configure = spawnSync(
      "cmake",
      [
        "-S",
        source,
        "-B",
        build,
        `-DFETCHCONTENT_SOURCE_DIR_LIBGIT2=${cached}`,
      ],
      { encoding: "utf8" },
    );
    expect(configure.status, configure.stdout + configure.stderr).toBe(0);
    if (missing) await rm(cached, { recursive: true });

    const result = spawnSync(
      process.execPath,
      [
        script,
        ...(explicit
          ? [`-DFETCHCONTENT_SOURCE_DIR_LIBGIT2=${replacement}`]
          : []),
      ],
      { cwd: directory, encoding: "utf8" },
    );
    const output = result.stdout + result.stderr;
    if (explicit === "missing") {
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(
        "Manually specified source directory is missing",
      );
      expect(output).toContain(replacement);
      return;
    }
    expect(result.status, output).toBe(0);
    expect(
      await readFile(path.join(build, "selected-libgit2.txt"), "utf8"),
    ).toBe(explicit ? "replacement" : missing ? "default" : "cached");
    const executable = path.join(
      build,
      "package",
      "jocki-renames" + (process.platform === "win32" ? ".exe" : ""),
    );
    expect(spawnSync(executable).status).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
