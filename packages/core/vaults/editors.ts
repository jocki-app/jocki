import {
  FileExtensionHost,
  applyTextEdits,
} from "../../platform/src/file-sdk/host";
import type { ExtensionDocument, TextEdit } from "../../platform/src/file-sdk";
import { canonical, utf8 } from "../crypto";
import { FileVault, fileText, type Draft } from "./vault";
import { contentTypes } from "./content-types";
import { validateType } from "./handlers";
import { validateCSDBType } from "./csdb";
import { parseCanvas } from "./canvas";
import { checkTemplateOnOpen } from "./templates";
import { importMetadata, relocatedResource } from "./metadata";

interface Session {
  vault: string;
  id: string;
  draft: Draft;
  version: number;
  snapshot?: ExtensionDocument;
  template?: string;
  resource?: string;
  instance?: string;
}
export class VaultEditors {
  private saves = new Map<string, Promise<unknown>>();
  readonly sessions = new Map<string, Session>();
  private listeners = new Set<() => void>();
  constructor(
    readonly vaults: Map<string, FileVault>,
    readonly extensions: FileExtensionHost,
  ) {}
  private key(vault: string, id: string, instance?: string) {
    return vault + "/" + id + (instance ? "@" + instance : "");
  }
  private require(vault: string, id: string, instance?: string) {
    const session = this.sessions.get(this.key(vault, id, instance));
    if (!session) throw Error("Document is not open");
    return session;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.listeners.forEach((fn) => fn());
  }
  snapshot(vault: string, id: string, instance?: string): ExtensionDocument {
    const session = this.require(vault, id, instance),
      file = this.vaults.get(vault)!.entry(id),
      draft = session.draft;
    let metadata = {
      properties: {} as Record<string, unknown>,
      contentType: null as string | null,
    };
    try {
      if (!draft.invalidResource)
        metadata = importMetadata(
          file.path,
          draft.mime,
          draft.text,
          draft.resource,
        );
    } catch {}
    return {
      vault,
      id,
      path: file.path,
      mime: draft.mime,
      contentType: metadata.contentType,
      resource: draft.resource ? structuredClone(draft.resource) : null,
      metadata: metadata.properties,
      text: draft.text,
      bytes: new Uint8Array(draft.bytes),
      dirty: draft.dirty,
      version: session.version,
      ...(instance ? { instance } : {}),
    };
  }
  documents() {
    return [...this.sessions.values()].map((s) =>
      this.snapshot(s.vault, s.id, s.instance),
    );
  }
  private opening = new Map<string, Promise<Session>>();
  open(vault: string, id: string, instance?: string) {
    const key = this.key(vault, id, instance),
      pending = this.opening.get(key);
    if (pending) return pending;
    const work = this.openSession(vault, id, instance);
    this.opening.set(key, work);
    void work
      .finally(() => {
        if (this.opening.get(key) === work) this.opening.delete(key);
      })
      .catch(() => {});
    return work;
  }
  private async openSession(vault: string, id: string, instance?: string) {
    const key = this.key(vault, id, instance),
      existing = this.sessions.get(key);
    if (existing) return existing;
    await this.vaults.get(vault)!.load(id);
    const draft = this.vaults.get(vault)!.draft(id);
    await checkTemplateOnOpen(draft, async (source) => {
      const sources = [...this.vaults.values()].filter((vault) =>
        vault.list().some((file) => file.id === source.file),
      );
      if (sources.length > 1)
        throw Error("Template identity is open in multiple locations");
      const vault = sources[0];
      if (!vault) return;
      await vault.reconcile([
        { path: vault.entry(source.file).path, type: "change" },
      ]);
      await vault.load(source.file);
      return fileText(vault.doc(source.file));
    });
    const session: Session = { vault, id, draft, version: 1, instance };
    this.sessions.set(key, session);
    session.snapshot = this.snapshot(vault, id, instance);
    session.template = canonical(draft.template);
    session.resource = canonical([draft.resource, draft.invalidResource]);
    const contentType = draft.contentType;
    if (contentType)
      await this.extensions.activateEvent("onContentType:" + contentType);
    this.extensions.didOpenDocument(this.snapshot(vault, id, instance));
    this.notify();
    return session;
  }
  changed(
    vault: string,
    id: string,
    reason: "edit" | "remote" | "discard" | "save" | "template" = "edit",
    instance?: string,
  ) {
    const session = this.require(vault, id, instance),
      document = this.snapshot(vault, id, instance),
      prior = session.snapshot,
      template = canonical(session.draft.template),
      resource = canonical([
        session.draft.resource,
        session.draft.invalidResource,
      ]);
    if (
      prior &&
      prior.text === document.text &&
      prior.path === document.path &&
      prior.mime === document.mime &&
      prior.contentType === document.contentType &&
      prior.dirty === document.dirty &&
      session.template === template &&
      session.resource === resource &&
      prior.bytes.length === document.bytes.length &&
      prior.bytes.every((byte, i) => byte === document.bytes[i])
    )
      return;
    document.version = ++session.version;
    session.snapshot = document;
    session.template = template;
    session.resource = resource;
    this.extensions.didChangeDocument({ document, reason });
    this.notify();
  }
  update(vault: string, id: string, edits: TextEdit[], instance?: string) {
    const session = this.require(vault, id, instance);
    session.draft.text = applyTextEdits(session.draft.text, edits);
    this.changed(vault, id, "edit", instance);
  }
  private async prepareSave(
    vault: string,
    id: string,
    path?: string,
    instance?: string,
  ) {
    const session = this.require(vault, id, instance);
    const version = session.version;
    const edits = await this.extensions.willSaveDocument(
      this.snapshot(vault, id, instance),
    );
    if (session.version !== version)
      throw Error("Document changed during a save hook; retry Save");
    if (edits.length) this.update(vault, id, edits, instance);
    const doc = this.snapshot(vault, id, instance);
    validateType(path ? { ...doc, path } : doc, contentTypes);
    if (doc.mime === "application/vnd.csdb")
      validateCSDBType(
        doc.text,
        contentTypes.find((t) => t.id === doc.contentType),
      );
    if (doc.mime === "application/vnd.canvas+json") parseCanvas(doc.text);
  }
  async saveCopy(
    vault: string,
    id: string,
    destination: string,
    path: string,
    instance?: string,
  ) {
    await this.prepareSave(vault, id, path, instance);
    const draft = this.require(vault, id, instance).draft,
      core = this.vaults.get(destination);
    if (!core) throw Error("Destination vault is not open");
    return core.create(
      path,
      this.vaults.get(vault)!.doc(id).kind === "text"
        ? utf8.encode(draft.text)
        : new Uint8Array(draft.bytes),
      {
        mime: draft.mime,
        resource: relocatedResource(
          draft.resource,
          this.vaults.get(vault)!.entry(id).path,
          path,
        ),
        invalidResource: draft.invalidResource,
      },
    );
  }
  save(
    vault: string,
    id: string,
    instance?: string,
    description = "",
    rows?: import("./csdb").CSDBRowSelection,
  ) {
    const key = this.key(vault, id, instance);
    const pending = (this.saves.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.performSave(vault, id, instance, description, rows));
    this.saves.set(key, pending);
    const cleanup = () => {
      if (this.saves.get(key) === pending) this.saves.delete(key);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }
  private async performSave(
    vault: string,
    id: string,
    instance: string | undefined,
    description: string,
    rows?: import("./csdb").CSDBRowSelection,
  ) {
    await this.prepareSave(vault, id, undefined, instance);
    const session = this.require(vault, id, instance),
      core = this.vaults.get(vault)!;
    session.draft = await core.save(session.draft, description, rows);
    this.changed(vault, id, "save", instance);
    this.extensions.didSaveDocument(this.snapshot(vault, id, instance));
    this.notify();
    return session.draft;
  }
  discard(vault: string, id: string, instance?: string) {
    if (this.saves.has(this.key(vault, id, instance)))
      throw Error(
        "Wait for the current save to finish before discarding changes",
      );
    const session = this.require(vault, id, instance),
      core = this.vaults.get(vault)!;
    core.release(session.draft);
    session.draft = core.draft(id);
    this.changed(vault, id, "discard", instance);
    return session.draft;
  }
  refresh(vault: string, id: string, instance?: string) {
    const session = this.require(vault, id, instance);
    if (session.draft.dirty) return session.draft;
    const core = this.vaults.get(vault)!;
    core.release(session.draft);
    session.draft = core.draft(id);
    this.changed(vault, id, "remote", instance);
    return session.draft;
  }
  replace(vault: string, id: string, draft: Draft, instance?: string) {
    const session = this.require(vault, id, instance);
    this.vaults.get(vault)!.release(session.draft);
    session.draft = draft;
    this.changed(vault, id, "edit", instance);
    return draft;
  }
  async close(vault: string, id: string, discard = false, instance?: string) {
    await this.saves.get(this.key(vault, id, instance));
    const session = this.require(vault, id, instance);
    if (session.draft.dirty && !discard)
      throw Error("Save or discard changes before closing");
    this.extensions.didCloseDocument(this.snapshot(vault, id, instance));
    this.vaults.get(vault)!.release(session.draft);
    this.sessions.delete(this.key(vault, id, instance));
    this.notify();
    await this.vaults.get(vault)!.compactLocal(id);
  }
}
