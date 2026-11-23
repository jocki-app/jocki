import { it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { signPackage } from "../packages/platform/src/packages/signed-package";
import { verifyFileExtensionArtifact } from "../packages/platform/src/file-sdk/artifact";
const keys = generateKeyPairSync("ed25519"),
  trust = {
    example: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
async function files() {
  return Object.fromEntries(
    await Promise.all(
      ["extension.json", "extension.mjs", "LICENSE"].map(async (name) => [
        name,
        new Uint8Array(await readFile("examples/file-extension/" + name)),
      ]),
    ),
  );
}
const pack = (files: Record<string, Uint8Array>) =>
  signPackage(
    files,
    "example",
    async (bytes) => new Uint8Array(sign(null, bytes, keys.privateKey)),
  );
it("verifies a new file-extension package and rejects untrusted or tampered packages", async () => {
  const bytes = await pack(await files());
  expect((await verifyFileExtensionArtifact(bytes, trust)).manifest.api).toBe(
    "jocki-extensions/1",
  );
  await expect(verifyFileExtensionArtifact(bytes, {})).rejects.toThrow(
    "not trusted",
  );
  const zip = await JSZip.loadAsync(bytes);
  zip.file("extension.mjs", "export function activate(){};");
  await expect(
    verifyFileExtensionArtifact(
      await zip.generateAsync({ type: "uint8array" }),
      trust,
    ),
  ).rejects.toThrow();
});
it("requires the new manifest and license and rejects a reserved core namespace", async () => {
  const entries = await files();
  delete entries.LICENSE;
  await expect(
    verifyFileExtensionArtifact(await pack(entries), trust),
  ).rejects.toThrow("LICENSE");
  const legacy = await files();
  legacy["plugin.json"] = legacy["extension.json"];
  delete legacy["extension.json"];
  await expect(
    verifyFileExtensionArtifact(await pack(legacy), trust),
  ).rejects.toThrow("extension.json");
  const reserved = await files(),
    manifest = JSON.parse(new TextDecoder().decode(reserved["extension.json"]));
  manifest.id = "core.injected";
  manifest.contributes = {};
  reserved["extension.json"] = new TextEncoder().encode(
    JSON.stringify(manifest),
  );
  await expect(
    verifyFileExtensionArtifact(await pack(reserved), trust),
  ).rejects.toThrow("reserved namespace");
});
