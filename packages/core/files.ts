import type { WorkspaceNode } from "./device";
import type { Replica, DocumentReadiness } from "./replica";
import { digest, canonical } from "./crypto";
import { invariant } from "@jocki/platform/core/errors";
export interface FileManifest {
  id: string;
  fileId: string;
  parentVersionId: string | null;
  mediaType: string;
  size: number;
  checksum: string;
  chunks: string[];
  createdAt: string;
}
export const CHUNK_BYTES = 1024 * 1024;
/** Each binary chunk is its own Repo item document, indexed under the files plugin/schema. */
export class ReplicaFiles {
  readonly listeners = new Set<() => void>();
  revision = 0;
  constructor(readonly replica: Replica) {
    replica.listeners.add(() => {
      this.revision++;
      for (const listener of this.listeners) listener();
    });
  }
  async putChunk(hash: string, bytes: Uint8Array) {
    invariant(
      bytes.length <= CHUNK_BYTES && (await digest(bytes)) === hash,
      "INTEGRITY_FAILED",
      "File chunk checksum differs",
    );
    if (!this.replica.read("blob/" + hash))
      await this.replica.update("blob/" + hash, { bytes: bytes.slice() });
  }
  async getChunk(hash: string) {
    const bytes = this.replica.read<{ bytes: Uint8Array }>(
      "blob/" + hash,
    )?.bytes;
    if (bytes)
      invariant(
        (await digest(bytes)) === hash,
        "INTEGRITY_FAILED",
        "File chunk checksum differs",
      );
    return bytes;
  }
  async save(
    fileId: string,
    bytes: Uint8Array,
    mediaType: string,
    parentVersionId: string | null,
    id: string = crypto.randomUUID(),
  ) {
    invariant(
      bytes.length <= 512 * 1024 * 1024,
      "PAYLOAD_TOO_LARGE",
      "File exceeds 512 MB",
    );
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.slice(offset, offset + CHUNK_BYTES),
        hash = await digest(chunk);
      await this.putChunk(hash, chunk);
      chunks.push(hash);
    }
    const manifest: FileManifest = {
      id,
      fileId,
      parentVersionId,
      mediaType,
      size: bytes.length,
      checksum: await digest(bytes),
      chunks,
      createdAt: new Date().toISOString(),
    };
    const existing = this.replica.read<FileManifest>("file/" + id);
    if (existing) {
      invariant(
        canonical({ ...existing, createdAt: "" }) ===
          canonical({ ...manifest, createdAt: "" }),
        "IDEMPOTENCY_CONFLICT",
        "File version identifier was reused",
      );
      return existing;
    }
    await this.replica.update(
      "file/" + id,
      manifest as unknown as Record<string, unknown>,
    );
    return manifest;
  }
  manifests() {
    return this.replica
      .ids("file/")
      .flatMap((id) => this.replica.read<FileManifest>(id) ?? []);
  }
  async missing() {
    const hashes = new Set(this.manifests().flatMap((file) => file.chunks));
    return [...hashes].filter((hash) => !this.replica.read("blob/" + hash));
  }
  async hasVersion(id: string) {
    const manifest = this.replica.read<FileManifest>("file/" + id);
    return Boolean(
      manifest &&
      manifest.chunks.every((hash) => this.replica.read("blob/" + hash)),
    );
  }
  async initialize() {
    await this.replica.flush();
  }
  retainedVersion(id: string) {
    return Boolean(this.replica.read("file/" + id));
  }
  async availability(id: string): Promise<{
    state: DocumentReadiness;
    available: boolean;
    missing: number;
  }> {
    const manifest = this.replica.read<FileManifest>("file/" + id);
    const missing =
      manifest?.chunks.filter((hash) => !this.replica.read("blob/" + hash))
        .length ?? 0;
    return {
      state: this.replica.readiness("file/" + id),
      available: Boolean(manifest && !missing),
      missing,
    };
  }
  async readAvailable(id: string) {
    return (await this.hasVersion(id)) ? await this.read(id) : undefined;
  }
  async read(id: string, _includeReleased = false) {
    const manifest = this.replica.read<FileManifest>("file/" + id);
    invariant(manifest, "NOT_FOUND", "File version is unavailable");
    const bytes = new Uint8Array(manifest.size);
    let offset = 0;
    for (const hash of manifest.chunks) {
      const chunk = await this.getChunk(hash);
      invariant(
        chunk && offset + chunk.length <= bytes.length,
        "OFFLINE_UNAVAILABLE",
        "File bytes are still loading",
      );
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    invariant(
      offset === bytes.length && (await digest(bytes)) === manifest.checksum,
      "INTEGRITY_FAILED",
      "File checksum differs",
    );
    return { manifest, bytes };
  }
}
export async function saveRecordFile(
  node: WorkspaceNode,
  id: string,
  bytes: Uint8Array,
  mediaType: string,
  parent: string | null,
): Promise<FileManifest> {
  invariant(
    node.records.canWrite(),
    "PERMISSION_DENIED",
    "This device cannot edit this workspace",
  );
  const file = node.records.get(id);
  invariant(
    file?.collection === "files",
    "NOT_FOUND",
    "File record was not found",
  );
  const version = await node.protocol.files.save(id, bytes, mediaType, parent);
  // Preserve metadata edits made while the bytes were being persisted.
  const latest = node.records.get(id)!;
  invariant(!latest.deletedAt, "NOT_FOUND", "File was deleted during upload");
  await node.records.put(
    "files",
    {
      ...latest.data,
      version_id: version.id,
      size: String(version.size),
      media_type: version.mediaType,
      checksum: version.checksum,
      upload_state: "available",
    },
    id,
  );
  return version;
}
