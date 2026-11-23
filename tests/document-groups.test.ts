import { it, expect } from "vitest";
import {
  Access,
  ContactCard,
  MemberedId,
} from "@automerge/automerge-repo-keyhive";
import { MemoryStorage } from "../packages/storage";
import { testRepository } from "./fixtures/repository";
it("inherits document rights from a workspace group and persists edits", async () => {
  const a = await testRepository(new MemoryStorage()),
    b = await testRepository(new MemoryStorage());
  try {
    const group = await a.hive.keyhive.generateGroup([]);
    await a.hive.receiveContactCard(ContactCard.fromJson(b.contactCard));
    await a.hive.keyhive.addMember(
      b.hive.active.individual.id,
      MemberedId.group(group),
      Access.edit(),
      [],
    );
    const doc = await a.createGrouped(
      { test: true },
      Array.from(group.toBytes(), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
    expect(
      (await a.hive.bestAccessForDoc(a.hive.active.individual.id, doc.url))
        ?.isEditor,
    ).toBe(true);
    expect(
      (await a.hive.bestAccessForDoc(b.hive.active.individual.id, doc.url))
        ?.isEditor,
    ).toBe(true);
    doc.change((value) => {
      value.test = false;
    });
    await a.flush();
    await a.hive.keyhive.revokeMember(
      b.hive.active.individual.id,
      false,
      MemberedId.group(group),
    );
    expect(
      await a.hive.bestAccessForDoc(b.hive.active.individual.id, doc.url),
    ).toBeUndefined();
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
