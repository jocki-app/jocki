import { manifestSchema } from "./index";
import { invariant } from "../core/errors";
import { isRequiredCore, validateExtension } from "../core/catalog";
import type { InventoryEntry } from "./inventory";
import { verifyPackage, safePackagePath } from "../packages/verified-package";
export { safePackagePath, artifactHash } from "../packages/verified-package";
export function requiredGrants(
  manifest: ReturnType<typeof manifestSchema.parse>,
) {
  return [
    ...new Set([
      ...manifest.permissions,
      ...manifest.sharedServices.filter((s) => !s.optional).map((s) => s.id),
      ...manifest.consumes.commands,
      ...manifest.consumes.events,
    ]),
  ].sort();
}
export function inventoryGrants(
  manifest: ReturnType<typeof manifestSchema.parse>,
) {
  return [
    ...new Set([
      ...requiredGrants(manifest),
      ...manifest.sharedServices.map((service) => service.id),
    ]),
  ].sort();
}
export async function verifyArtifact(
  bytes: Uint8Array,
  trust: Record<string, string>,
  expected?: InventoryEntry,
) {
  const { files, digest, publisher } = await verifyPackage(
    bytes,
    trust,
    expected?.sha256,
  );
  invariant(
    files["plugin.json"] && files["schemas.json"] && files["LICENSE"],
    "INVALID_PACKAGE",
    "Package must contain plugin.json, schemas.json and LICENSE at its root",
  );
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder().decode(files["plugin.json"])),
  );
  invariant(
    manifest.publisher === publisher && !isRequiredCore(manifest.id),
    "RESERVED_PROVIDER",
    "Invalid package publisher or reserved plugin",
  );
  for (const entry of Object.values(manifest.entrypoints))
    invariant(
      entry && safePackagePath(entry) && files[entry],
      "INVALID_PACKAGE",
      "Entrypoint is missing",
    );
  if (expected) {
    for (const name of [
      "id",
      "version",
      "publisher",
      "name",
      "description",
      "license",
    ] as const)
      invariant(
        manifest[name] === expected[name],
        "INTEGRITY_FAILED",
        `Package ${name} differs from inventory`,
      );
    for (const [actual, wanted] of [
      [manifest.permissions, expected.permissions],
      [manifest.dependencies, expected.dependencies],
      [inventoryGrants(manifest), expected.grants],
    ])
      invariant(
        JSON.stringify([...actual].sort()) ===
          JSON.stringify([...wanted].sort()),
        "INTEGRITY_FAILED",
        "Package capabilities differ from the reviewed inventory",
      );
  }
  const contracts = JSON.parse(new TextDecoder().decode(files["schemas.json"]));
  validateExtension(manifest, contracts);
  return { manifest, contracts, files, digest };
}
