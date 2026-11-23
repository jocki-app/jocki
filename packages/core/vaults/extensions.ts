import { verifyFileExtensionArtifact } from "../../platform/src/file-sdk/artifact";
import type { FileExtensionManifest } from "../../platform/src/file-sdk";
import type { VaultFileSystem } from "./contracts";
import { utf8, text } from "../crypto";

interface InstalledPackage {
  id: string;
  version: string;
  sha256: string;
  publisher: string;
  publicKey: string;
}
/** Locally installed code and publisher trust are never loaded from replicated settings. */
export class FileExtensionPackages {
  private installed: InstalledPackage[] = [];
  private constructor(readonly storage: VaultFileSystem) {}
  static async open(storage: VaultFileSystem) {
    const packages = new FileExtensionPackages(storage),
      saved = await storage.read("extensions/catalog.json");
    if (saved) packages.installed = JSON.parse(text.decode(saved));
    for (const item of packages.installed)
      if (
        !/^[a-z][a-z0-9.-]*$/.test(item.id) ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      )
        throw Error("Invalid local extension catalog");
    return packages;
  }
  list() {
    return this.installed.map((p) => ({ ...p }));
  }
  private path(pkg: InstalledPackage) {
    return `extensions/packages/${pkg.id}/${pkg.sha256}.zip`;
  }
  private async persist() {
    await this.storage.writeAtomic(
      "extensions/catalog.json",
      utf8.encode(JSON.stringify(this.installed)),
    );
  }
  async install(
    bytes: Uint8Array,
    trust: Record<string, string>,
    expected?: { id: string; version: string; sha256: string },
    assertAllowed?: (manifest: FileExtensionManifest) => void,
  ) {
    const verified = await verifyFileExtensionArtifact(bytes, trust, expected);
    assertAllowed?.(verified.manifest);
    const pkg: InstalledPackage = {
      id: verified.manifest.id,
      version: verified.manifest.version,
      sha256: verified.digest,
      publisher: verified.publisher,
      publicKey: trust[verified.publisher],
    };
    await this.storage.writeAtomic(this.path(pkg), bytes);
    const previous = this.installed;
    this.installed = [...previous.filter((p) => p.id !== pkg.id), pkg];
    try {
      await this.persist();
    } catch (error) {
      this.installed = previous;
      throw error;
    }
    return verified;
  }
  async load(id: string) {
    const pkg = this.installed.find((p) => p.id === id);
    if (!pkg) throw Error("Extension is not installed on this computer");
    const bytes = await this.storage.read(this.path(pkg));
    if (!bytes) throw Error("Installed extension package is missing");
    return verifyFileExtensionArtifact(
      bytes,
      { [pkg.publisher]: pkg.publicKey },
      pkg,
    );
  }
  async remove(id: string) {
    const pkg = this.installed.find((p) => p.id === id);
    if (!pkg) return;
    const previous = this.installed;
    this.installed = previous.filter((p) => p.id !== id);
    try {
      await this.persist();
    } catch (error) {
      this.installed = previous;
      throw error;
    }
    await this.storage.remove(this.path(pkg));
  }
}
