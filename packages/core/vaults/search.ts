import * as A from "@automerge/automerge";
import { fileText, type FileVault } from "./vault";
import { utf8 } from "../crypto";
import { noteMetadata } from "./knowledge";
import type { ExtensionDocument } from "../../platform/src/file-sdk";
import MiniSearch from "minisearch";

export interface IndexedFile {
  id: string;
  vault: string;
  path: string;
  mime: string;
  contentType: string | null;
  text: string;
  tags: string[];
  metadata: string[];
  revision: string;
}
export interface SearchHit {
  file: IndexedFile;
  excerpt: string;
  score: number;
}
export class VaultSearch {
  private files = new Map<string, IndexedFile>();
  private indexes = new Map<string, MiniSearch>();
  private pendingWrites = new Set<string>();
  private index(vault: string) {
    let index = this.indexes.get(vault);
    if (!index) {
      index = new MiniSearch({
        fields: ["path", "text", "metadata"],
        searchOptions: { boost: { path: 5 }, combineWith: "AND", prefix: true },
      });
      this.indexes.set(vault, index);
    }
    return index;
  }
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private extract?: (doc: ExtensionDocument) => Promise<string>,
    private error: (error: unknown) => void = console.error,
  ) {}
  private extractorRevision = 0;
  invalidateExtractors() {
    this.extractorRevision++;
  }
  async update(vault: FileVault) {
    const pending = this.queue.then(() => this.updateIndex(vault));
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async updateIndex(vault: FileVault) {
    let changed = false;
    const current = vault.list();
    const ids = new Set(current.map((f) => f.id));
    for (const [id, file] of this.files)
      if (file.vault === vault.id && !ids.has(file.id)) {
        changed = true;
        this.files.delete(id);
        this.index(vault.id).discard(id);
      }
    const index: IndexedFile[] = [];
    for (const file of current) {
      let revision =
        vault.documentRevision(file.id) + ":" + this.extractorRevision;
      const wasLoaded = vault.isLoaded(file.id);
      const large = (vault.fileSize(file.id) ?? 0) > 8 * 1024 * 1024;
      const unchanged =
        this.files.get(vault.id + "/" + file.id)?.revision === revision;
      if (!unchanged && !large) await vault.load(file.id);
      const doc = vault.isLoaded(file.id) ? vault.doc(file.id) : undefined;
      revision = vault.documentRevision(file.id) + ":" + this.extractorRevision;
      const key = vault.id + "/" + file.id,
        prior = this.files.get(key);
      const value =
        prior?.revision === revision && prior.path === file.path
          ? prior
          : {
              id: file.id,
              vault: vault.id,
              path: file.path,
              mime: file.mime,
              contentType: vault.contentType(file.id),
              metadata: vault.metadata(file.id).terms,
              text: doc?.kind === "text" ? fileText(doc) : "",
              tags:
                doc?.mime === "text/markdown"
                  ? noteMetadata(doc.text).tags
                  : [],
              revision,
            };
      if (value !== prior && this.extract && doc && !large) {
        try {
          const extracted = await this.extract({
            vault: vault.id,
            id: file.id,
            path: file.path,
            mime: file.mime,
            contentType: vault.contentType(file.id),
            resource: A.toJS(doc).resource,
            metadata: structuredClone(vault.metadata(file.id).properties),
            text: fileText(doc),
            bytes: new Uint8Array(doc.bytes),
            dirty: false,
            version: 0,
          });
          if (extracted) value.text += "\n" + extracted;
        } catch (error) {
          this.error(error);
        }
      }
      if (value !== prior) {
        changed = true;
        const engine = this.index(vault.id);
        if (engine.has(key)) engine.discard(key);
        engine.add({
          id: key,
          path: value.path,
          text: value.text,
          metadata: value.metadata.join(" "),
        });
      }
      this.files.set(key, value);
      index.push(value);
      if (!wasLoaded && vault.isLoaded(file.id)) vault.unload(file.id);
    }
    if (changed) this.pendingWrites.add(vault.id);
    if (!this.pendingWrites.has(vault.id)) return;
    await vault.local.writeAtomic(
      "cache/index/files.json",
      utf8.encode(JSON.stringify({ version: 1, files: index })),
    );
    await vault.local.writeAtomic(
      "cache/index/search.json",
      utf8.encode(JSON.stringify(this.index(vault.id))),
    );
    this.pendingWrites.delete(vault.id);
  }
  remove(vault: string) {
    for (const [id, file] of this.files)
      if (file.vault === vault) this.files.delete(id);
    this.indexes.delete(vault);
  }
  all() {
    return [...this.files.values()];
  }
  search(query: string, limit = 100): SearchHit[] {
    const tokens = query.match(/(?:[^\s"]+"[^"]*"|"[^"]*"|\S+)/g) ?? [];
    const positive = tokens
      .filter((token) => !token.startsWith("-") && !/^[\w-]+:/.test(token))
      .map((token) => token.replace(/^"|"$/g, ""))
      .join(" ");
    const scores = new Map<string, number>();
    if (positive)
      for (const engine of this.indexes.values())
        for (const hit of engine.search(positive))
          scores.set(String(hit.id), hit.score);
    const candidates = positive
      ? [...scores.keys()].map((key) => this.files.get(key)!).filter(Boolean)
      : this.all();
    return candidates
      .flatMap((file) => {
        const haystack =
          `${file.path}\n${file.text}\n${file.metadata.join(" ")}`.toLowerCase();
        let first = -1,
          score = scores.get(file.vault + "/" + file.id) ?? 0;
        for (let token of tokens) {
          const negate = token.startsWith("-");
          if (negate) token = token.slice(1);
          const split = token.indexOf(":"),
            field = split > 0 ? token.slice(0, split) : "";
          const value = (split > 0 ? token.slice(split + 1) : token)
            .replace(/^"|"$/g, "")
            .toLowerCase();
          let matches: boolean;
          if (field === "metadata")
            matches = file.metadata.some((term) =>
              term.toLowerCase().includes(value),
            );
          else if (field === "type")
            matches = (file.contentType ?? "untyped").includes(value);
          else if (field === "mime") matches = file.mime.includes(value);
          else if (field === "path")
            matches = file.path.toLowerCase().includes(value);
          else if (field === "vault")
            matches = file.vault.toLowerCase().includes(value);
          else {
            const offset = haystack.indexOf(
              token.replace(/^"|"$/g, "").toLowerCase(),
            );
            matches = offset >= 0;
            if (first < 0) first = offset;
          }
          if (matches === negate) return [];
          if (matches)
            score += file.path.toLowerCase().includes(value) ? 10 : 1;
        }
        const excerptStart = Math.max(0, first - file.path.length - 1 - 50);
        return [
          {
            file,
            score,
            excerpt: file.text
              .slice(excerptStart, excerptStart + 220)
              .replace(/\n/g, " "),
          },
        ];
      })
      .sort(
        (a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path),
      )
      .slice(0, limit);
  }
}
