import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openNodeRepository } from "../packages/platform-node/repository";
import { isUnprotectedDoc } from "@automerge/automerge-repo-keyhive";
import { parseAutomergeUrl } from "@automerge/automerge-repo";
import { DeviceCore } from "../packages/core/device";
import { FileStorage } from "../packages/platform-node/storage";
import { documentsService } from "../packages/core/documents-service";
import { pluginSettings } from "../packages/core/plugin-settings";

describe("Automerge Repo", () => {
  it("durably deletes retained document chunks before acknowledging removal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jocki-prune-"));
    const repository = await openNodeRepository(directory);
    try {
      const doc = await repository.create({ text: "retained version" });
      doc.change((value) => {
        value.text = "current";
      });
      await repository.flush();
      const { documentId } = parseAutomergeUrl(doc.url);
      expect(
        await repository.repo.storageSubsystem!.loadDocData(documentId),
      ).not.toBeNull();
      await repository.removeDocument(doc.url);
      expect(doc.state).toBe("deleted");
      expect(
        await repository.repo.storageSubsystem!.loadDocData(documentId),
      ).toBeNull();
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("restores the document hierarchy and both settings documents after a filesystem restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jocki-graph-"));
    let core: DeviceCore | undefined;
    const open = async () =>
      DeviceCore.open(
        new FileStorage(directory),
        "Computer",
        () => [],
        await openNodeRepository(path.join(directory, "automerge")),
      );
    try {
      core = await open();
      const node = await core.createWorkspace("Persistent hierarchy");
      const task = await node.records.put("tasks", { title: "Saved task" });
      const documents = documentsService(node, "notes"),
        settings = pluginSettings(node.replica, "notes");
      const page = await documents.open(
        documents.defaultSchemaId,
        "page",
        "one",
        { text: "Saved page" },
      );
      page.change((doc) => {
        doc.text = "Edited page";
      });
      await documents.flush();
      await settings.set("view", "board");
      await settings.computer.set("view", "list");
      const link = core.profiles()[0],
        rootHeads = node.replica.handle.heads(),
        pageUrl = page.url;
      await core.close();
      core = await open();
      const restored = await core.workspace(link.id),
        restoredDocuments = documentsService(restored, "notes");
      expect(core.profiles()[0]).toEqual(link);
      expect(restored.replica.handle.heads()).toEqual(rootHeads);
      expect(restored.records.get(task.id)?.data.title).toBe("Saved task");
      const restoredPage = await restoredDocuments.open<{ text: string }>(
        restoredDocuments.defaultSchemaId,
        "page",
        "one",
      );
      expect(restoredPage.url).toBe(pageUrl);
      expect(restoredPage.doc()?.text).toBe("Edited page");
      const restoredSettings = pluginSettings(restored.replica, "notes");
      expect(await restoredSettings.get("view")).toBe("board");
      expect(await restoredSettings.computer.get("view")).toBe("list");
    } finally {
      await core?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists a protected document and the same identity in an official filesystem store", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jocki-repo-"));
    try {
      const first = await openNodeRepository(directory);
      const identity = first.hive.active.individual.id.toBytes();
      const handle = await first.create({
        todos: [{ title: "Start simple", done: false }],
      });
      expect(isUnprotectedDoc(handle.url)).toBe(false);
      handle.change((doc) => {
        doc.todos[0].done = true;
      });
      const url = handle.url;
      await first.close();
      const second = await openNodeRepository(directory);
      try {
        expect(second.hive.active.individual.id.toBytes()).toEqual(identity);
        const restored = await second.repo.find<{
          todos: { title: string; done: boolean }[];
        }>(url);
        expect(restored.doc()?.todos[0].done).toBe(true);
        expect(
          (await second.hive.listMembers(url)).some(
            (member) => member.isSelf && member.access.isEditor,
          ),
        ).toBe(true);
      } finally {
        await second.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
