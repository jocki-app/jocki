import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await readFile("package-lock.json", "utf8")),
  notices = [
    "Jocki third-party notices\nRuntime dependencies; some packages are used only on particular platforms.\n",
  ];
for (const [directory, entry] of Object.entries(lock.packages).sort(
  ([a], [b]) => a.localeCompare(b),
)) {
  if (!directory.startsWith("node_modules/") || entry.dev || entry.link)
    continue;
  try {
    const pkg = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ),
      texts = [];
    for (const name of (await readdir(directory)).filter((name) =>
      /^(license|licence|copying|notice)(\.|$)/i.test(name),
    ))
      try {
        texts.push(await readFile(path.join(directory, name), "utf8"));
      } catch {}
    notices.push(
      `${pkg.name}@${pkg.version}\nLicense: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? "See package source")}\n${texts.join("\n")}\n`,
    );
  } catch {}
}
notices.push(
  "CSDB TypeScript reference implementation — GPL-3.0-or-later\nhttps://github.com/csvdatabase/csdb-typescript\n" +
    (await readFile("node_modules/@csvdatabase/csdb/LICENSE", "utf8")),
  "libgit2 1.9.7 — GPL-2.0-only WITH linking exception\nUnmodified source: https://github.com/libgit2/libgit2/tree/v1.9.7\n" +
    (await readFile("native/renames/LICENSE.libgit2", "utf8")),
  "DuckDB JSON Wasm extension 1.5.6 — MIT\n" +
    (await readFile("packages/platform/assets/duckdb/LICENSE", "utf8")),
);
await writeFile(
  "public/THIRD_PARTY_NOTICES.txt",
  notices.join("\n----------------------------------------\n\n"),
);
