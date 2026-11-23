import JSZip from "jszip";
import { artifactHash, safePackagePath } from "./verified-package";
export async function signPackage(
  files: Record<string, Uint8Array>,
  publisher: string,
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
) {
  if (
    Object.keys(files).length > 1000 ||
    Object.values(files).reduce((n, bytes) => n + bytes.length, 0) >
      50 * 1024 * 1024
  )
    throw Error("Package exceeds size limits");
  const index: {
    format: number;
    publisher: string;
    files: Record<string, { sha256: string; size: number }>;
  } = { format: 1, publisher, files: {} };
  for (const [name, bytes] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (
      !safePackagePath(name) ||
      ["package-index.json", "package-signature", "artifact.zip"].includes(name)
    )
      throw Error("Unsafe or reserved package path");
    index.files[name] = {
      sha256: await artifactHash(bytes),
      size: bytes.length,
    };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(index)),
    signature = await sign(bytes),
    zip = new JSZip();
  zip.file("package-index.json", bytes);
  zip.file("package-signature", btoa(String.fromCharCode(...signature)));
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
