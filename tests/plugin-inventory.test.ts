import { expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  inventorySchema,
  inventorySources,
  mergeInventories,
  readInventories,
  type PluginInventory,
} from "@jocki/platform/plugin-sdk/inventory";
import { verifyArtifact } from "@jocki/platform/plugin-sdk/artifact";
import { packPlugin } from "../packages/platform-node/compat/plugin-packages";

function inventory(
  id: string,
  version = "1.0.0",
  publisher = "example",
): PluginInventory {
  return inventorySchema.parse({
    schemaVersion: 1,
    name: "Example source",
    publishers: { [publisher]: "public key" },
    plugins: [
      {
        id,
        version,
        publisher,
        name: id,
        description: "Example plugin",
        license: "MIT",
        downloadUrl: `https://example.com/${id}.zip`,
        sha256: "a".repeat(64),
        permissions: [],
        grants: [],
      },
    ],
  });
}
it("merges plugin sources, deduplicates immutable releases and selects the newest semantic version", () => {
  const merged = mergeInventories([
    inventory("sample", "1.9.0"),
    inventory("other"),
    inventory("sample", "1.10.0"),
    inventory("sample", "1.10.0"),
  ]);
  expect(merged.plugins.map((entry) => [entry.id, entry.version])).toEqual([
    ["sample", "1.10.0"],
    ["other", "1.0.0"],
  ]);
  expect(mergeInventories([]).plugins).toEqual([]);
});
it("rejects conflicting publisher keys, package ownership and immutable release digests", () => {
  const changedKey = inventory("other");
  changedKey.publishers.example = "different key";
  expect(() => mergeInventories([inventory("sample"), changedKey])).toThrow(
    "key for example",
  );
  expect(() =>
    mergeInventories([
      inventory("sample"),
      inventory("sample", "2.0.0", "someone-else"),
    ]),
  ).toThrow("publisher for sample");
  const changedRelease = inventory("sample");
  changedRelease.plugins[0].sha256 = "b".repeat(64);
  expect(() => mergeInventories([inventory("sample"), changedRelease])).toThrow(
    "sample@1.0.0",
  );
});
it("normalizes source URLs and rejects credentials, fragments, invalid protocols and oversized lists", () => {
  expect(
    inventorySources(["https://EXAMPLE.com", "https://example.com/"]),
  ).toEqual(["https://example.com/"]);
  for (const url of [
    "https://user:password@example.com/list.json",
    "https://example.com/#key",
    "file:///plugins.json",
    "http://example.com/plugins.json",
  ])
    expect(() => inventorySources([url])).toThrow();
  expect(
    inventorySources(["http://localhost:1234/plugins.json"], true),
  ).toHaveLength(1);
  expect(() =>
    inventorySources(Array(21).fill("https://example.com/")),
  ).toThrow();
});
it("fetches each configured source once and fails a refresh if any source is unavailable", async () => {
  const requests: string[] = [];
  const fetcher = (async (url: URL) => {
    requests.push(url.href);
    return url.pathname === "/broken.json"
      ? new Response("Unavailable", { status: 503 })
      : new Response(
          JSON.stringify(
            inventory(url.pathname === "/one.json" ? "first" : "second"),
          ),
        );
  }) as typeof fetch;
  const result = await readInventories(
    [
      "https://example.com/one.json",
      "https://example.com/two.json",
      "https://example.com/one.json",
    ],
    { fetch: fetcher },
  );
  expect(requests).toHaveLength(2);
  expect(result.plugins.map((entry) => entry.id)).toEqual(["first", "second"]);
  await expect(
    readInventories(
      ["https://example.com/one.json", "https://example.com/broken.json"],
      { fetch: fetcher },
    ),
  ).rejects.toThrow("503");
});
it("verifies locally packed ZIPs and rejects untrusted, altered and incomplete packages", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jocki-local-plugin-"),
  );
  const keys = generateKeyPairSync("ed25519");
  const key = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const trust = {
    example: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const keyFile = directory + ".pem",
    output = directory + ".zip";
  try {
    await writeFile(
      path.join(directory, "plugin.json"),
      JSON.stringify({
        id: "local-example",
        name: "Local example",
        description: "An imported plugin",
        publisher: "example",
        license: "MIT",
        version: "1.0.0",
        platformApi: "^1.0.0",
        fieldSchemaApi: "^1.0.0",
        entrypoints: { core: "core.mjs" },
        ui: { mode: "none" },
        storage: { local: { mode: "none" } },
        permissions: [],
        dependencies: [],
        sharedServices: [],
        provides: { commands: [], events: [] },
        consumes: { commands: [], events: [] },
      }),
    );
    await writeFile(path.join(directory, "schemas.json"), "[]");
    await writeFile(path.join(directory, "LICENSE"), "MIT");
    await writeFile(
      path.join(directory, "core.mjs"),
      "export default {async activate(){}};",
    );
    await writeFile(keyFile, key, { mode: 0o600, flag: "wx" });
    const pack = () =>
      promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "scripts/pack-plugin.ts",
        directory,
        keyFile,
        output,
      ]);
    await pack();
    const bytes = await readFile(output);
    const verified = await verifyArtifact(bytes, trust);
    expect(verified.manifest.id).toBe("local-example");
    await expect(pack()).rejects.toThrow("EEXIST");
    await expect(verifyArtifact(bytes, {})).rejects.toThrow("not trusted");
    const altered = await JSZip.loadAsync(bytes);
    altered.file(
      "core.mjs",
      "export default {async activate(){throw Error('changed')}};",
    );
    await expect(
      verifyArtifact(
        await altered.generateAsync({ type: "uint8array" }),
        trust,
      ),
    ).rejects.toThrow(/size changed|integrity/);
    await rm(path.join(directory, "LICENSE"));
    await expect(
      verifyArtifact(await packPlugin(directory, key), trust),
    ).rejects.toThrow("LICENSE");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(keyFile, { force: true });
    await rm(output, { force: true });
  }
});
