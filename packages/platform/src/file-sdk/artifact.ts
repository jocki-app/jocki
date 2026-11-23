import { fileExtensionManifestSchema } from "./index";
import { verifyPackage, safePackagePath } from "../packages/verified-package";
export async function verifyFileExtensionArtifact(
  bytes: Uint8Array,
  trust: Record<string, string>,
  expected?: { sha256: string; id: string; version: string },
) {
  const verified = await verifyPackage(bytes, trust, expected?.sha256);
  const { files, publisher } = verified;
  if (!files["extension.json"] || !files.LICENSE)
    throw Error("File extension packages require extension.json and LICENSE");
  const manifest = fileExtensionManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(files["extension.json"])),
  );
  if (manifest.publisher !== publisher || manifest.id.startsWith("core."))
    throw Error("Invalid extension publisher or reserved namespace");
  if (
    expected &&
    (manifest.id !== expected.id || manifest.version !== expected.version)
  )
    throw Error("Extension differs from its inventory entry");
  for (const entry of Object.values(manifest.entrypoints))
    if (!entry || !safePackagePath(entry) || !files[entry])
      throw Error("Extension entrypoint is missing");
  for (const template of manifest.contributes.templates)
    if (
      template.file &&
      (!safePackagePath(template.file) || !files[template.file])
    )
      throw Error("Template file is missing from the signed package");
  return { ...verified, manifest };
}
