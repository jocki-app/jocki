import { readdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sign, createPublicKey } from "node:crypto";
import { signPackage } from "../packages/platform/src/packages/signed-package";
import { verifyFileExtensionArtifact } from "../packages/platform/src/file-sdk/artifact";
import { fileExtensionManifestSchema } from "../packages/platform/src/file-sdk";
const [directory, keyFile, target] = process.argv.slice(2);
if (directory === "--help") {
  console.log(
    "Usage: npm run extension:pack -- <built-directory> <private-key.pem> <output.zip>",
  );
  process.exit(0);
}
if (!directory || !keyFile || !target)
  throw Error(
    "Usage: npm run extension:pack -- <built-directory> <private-key.pem> <output.zip>",
  );
const root = await realpath(directory),
  keyPath = await realpath(keyFile),
  output = path.resolve(target);
for (const candidate of [keyPath, output])
  if (!path.relative(root, candidate).startsWith(".." + path.sep))
    throw Error("Keep keys and output packages outside the source directory");
const files: Record<string, Uint8Array> = {};
async function visit(dir: string, prefix = "") {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.name === "node_modules") continue;
    if (item.isSymbolicLink())
      throw Error("Package symlinks are not supported");
    if (item.isDirectory())
      await visit(path.join(dir, item.name), prefix + item.name + "/");
    else if (item.isFile())
      files[prefix + item.name] = new Uint8Array(
        await readFile(path.join(dir, item.name)),
      );
  }
}
await visit(root);
const manifest = fileExtensionManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(files["extension.json"])),
  ),
  key = await readFile(keyPath, "utf8");
const bytes = await signPackage(
  files,
  manifest.publisher,
  async (bytes) => new Uint8Array(sign(null, bytes, key)),
);
await verifyFileExtensionArtifact(bytes, {
  [manifest.publisher]: createPublicKey(key)
    .export({ format: "pem", type: "spki" })
    .toString(),
});
await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
console.log(
  `Created verified file extension ${manifest.id} ${manifest.version}`,
);
