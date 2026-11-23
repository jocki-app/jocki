import { expect, it } from "vitest";
import { generateAutomergeUrl } from "@automerge/automerge-repo";
import {
  parseShareLink,
  shareLink,
} from "../packages/core/vaults/share-invitation";
it("encodes all share kinds as one-line links without losing Unicode names", () => {
  for (const kind of ["workspace", "vault", "folder", "file"] as const) {
    const invitation = {
      format: "saddle-share-invitation/1" as const,
      kind,
      name: "Notes/日本語 note.md",
      url: generateAutomergeUrl(),
    };
    const link = shareLink(invitation);
    expect(link).toMatch(/^jocki:\/\/share\/[A-Za-z0-9_-]+$/);
    expect(parseShareLink("  " + link + "\n")).toEqual(invitation);
    expect(() => parseShareLink(JSON.stringify(invitation))).toThrow();
    expect(() => parseShareLink(link + "?kind=workspace")).toThrow();
  }
});
it("rejects invalid links, unknown fields, excessive input and forged URL shapes before any network access", () => {
  for (const value of [
    "",
    "https://example.test",
    "saddle://share/_",
    "saddle://share/" + "a".repeat(20001),
  ])
    expect(() => parseShareLink(value)).toThrow();
  const encoded = (value: unknown) =>
    "saddle://share/" +
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const invitation = {
    format: "saddle-share-invitation/1",
    kind: "file",
    name: "note.md",
    url: "automerge:invalid",
  };
  expect(() => parseShareLink(encoded(invitation))).toThrow();
  expect(() =>
    parseShareLink(encoded({ ...invitation, kind: "device" })),
  ).toThrow();
  expect(() =>
    parseShareLink(encoded({ ...invitation, path: "/etc/passwd" })),
  ).toThrow();
});
