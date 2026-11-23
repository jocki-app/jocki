import { expect, it } from "vitest";
import {
  effectiveShareCounter,
  rollbackVersionCount,
  scopeColorRatio,
  scopeCountKey,
} from "../packages/app-ui/vault-scope-counts";
import type { ShareSummary } from "../packages/core/vaults/protected-sync";
import { FileVault } from "../packages/core/vaults/vault";
import { WorkspaceStore } from "../packages/core/vaults/workspace";
import type { VaultRuntime } from "../packages/platform-browser/vault-runtime";
import { CompanionFiles } from "./fixtures/companion-files";
import { utf8 } from "../packages/core/crypto";

it("counts rollback rows rather than ancestor documents, including lazy files and retained folders", async () => {
  const fs = new CompanionFiles();
  let vault = await FileVault.open(fs, "one");
  const workspace = await WorkspaceStore.open(new CompanionFiles(), "one");
  const runtime = { workspace } as VaultRuntime;
  await vault.configure({ history: true });
  const id = await vault.create("parent/deep/note.md", utf8.encode("first"));
  for (const value of ["second", "third", "fourth"]) {
    const draft = vault.draft(id);
    draft.text = value;
    await vault.save(draft, value);
  }
  const versions = vault.history(id).length;
  expect(versions).toBe(4);
  expect(await rollbackVersionCount(runtime, { vault, id })).toBe(versions);
  expect(await rollbackVersionCount(runtime, {})).toBe(0);
  await workspace.configure({ history: true });
  expect(await rollbackVersionCount(runtime, {})).toBe(
    workspace.history().length,
  );
  vault = await FileVault.open(fs, "one", { lazy: true });
  vault.unload(id);
  expect(vault.isLoaded(id)).toBe(false);
  expect(await rollbackVersionCount(runtime, { vault, id })).toBe(versions);
  expect(vault.isLoaded(id)).toBe(false); // No file content loading or diff generation.
  await vault.configure({ sync: true });
  await vault.configureScope("folder", "parent", { history: false });
  expect(await rollbackVersionCount(runtime, { vault, id })).toBe(0);
  expect(await rollbackVersionCount(runtime, { vault, path: "parent" })).toBe(
    vault.folderHistory("parent").length,
  );
  await vault.configureScope("file", id, { history: true });
  expect(await rollbackVersionCount(runtime, { vault, id })).toBe(
    vault.history(id).length,
  );
  await vault.remove(id);
  expect(await rollbackVersionCount(runtime, { vault, id })).toBe(
    vault.history(id).length,
  );
});

it("counts overlapping broadcast rows by stable file identity, prefix and mount, with nearest overrides", async () => {
  const vault = await FileVault.open(new CompanionFiles(), "one");
  const other = await FileVault.open(new CompanionFiles(), "two");
  const workspace = await WorkspaceStore.open(new CompanionFiles(), "one");
  await workspace.configure({ sync: true });
  await vault.inheritFeatures(workspace.features);
  await other.inheritFeatures(workspace.features);
  await vault.configure({ sync: true });
  await vault.configureScope("folder", "parent", { sync: true });
  await vault.configureScope("folder", "parent/deep", { sync: true });
  const id = await vault.create("parent/deep/note.md", utf8.encode("note"));
  const sibling = await vault.create("parents/note.md", utf8.encode("sibling"));
  const elsewhere = await other.create(
    "parent/deep/note.md",
    utf8.encode("other"),
  );
  await vault.configureScope("file", id, { sync: true });
  const runtime = {
    workspace,
    vaults: new Map([
      [vault.id, vault],
      [other.id, other],
    ]),
  } as VaultRuntime;
  const row = (
    url: string,
    kind: ShareSummary["invitation"]["kind"],
    prefix = "",
    rootFile: string | null = null,
    broadcast = true,
  ) =>
    ({
      invitation: { url, kind },
      vault: kind === "workspace" ? null : vault.id,
      prefix,
      rootFile,
      broadcast,
    }) as ShareSummary;
  const shares = [
    row("workspace", "workspace"),
    row("root", "vault"),
    row("parent", "folder", "parent"),
    row("deep", "folder", "parent/deep"),
    row("file", "file", "stale/path.md", id),
    row("paused", "folder", "parent", null, false),
  ];
  shares.push(shares[2]); // The same row arriving twice is not another audience.
  const count = () => effectiveShareCounter(runtime, shares, true);
  const file = { vault, id, path: "parent/deep/note.md" };
  expect(count()({})).toBe(1);
  expect(count()({ vault, path: "" })).toBe(2);
  expect(count()({ vault, path: "parent" })).toBe(3);
  expect(count()({ vault, path: "parent/deep" })).toBe(4);
  expect(count()(file)).toBe(5);
  expect(count()({ vault, id })).toBe(5);
  expect(count()({ vault, id: sibling, path: "parents/note.md" })).toBe(2);
  expect(
    count()({ vault: other, id: elsewhere, path: "parent/deep/note.md" }),
  ).toBe(1);
  expect(effectiveShareCounter(runtime, shares, false)(file)).toBe(0);
  await vault.configureScope("folder", "parent", { sync: false });
  await vault.configureScope("file", id, { sync: undefined });
  await vault.configureScope("folder", "parent/deep", { sync: undefined });
  expect(count()(file)).toBe(0);
  await vault.configureScope("file", id, { sync: true });
  expect(count()(file)).toBe(3); // An explicitly enabled child still uses covering rows.
  await vault.move(id, "elsewhere/renamed.md");
  expect(count()({ vault, id, path: "elsewhere/renamed.md" })).toBe(3);
  const nested = () =>
    effectiveShareCounter(
      runtime,
      [row("mounted", "vault", "parent/deep")],
      true,
    );
  expect(nested()({ vault, path: "" })).toBe(0);
  expect(nested()({ vault, path: "parent" })).toBe(0);
  await vault.configureScope("folder", "parent/deep", { sync: true });
  expect(nested()({ vault, path: "parent/deep" })).toBe(1);
});

it("normalizes positive counts evenly between bounded endpoints independently of expanded levels", () => {
  expect([0, 1, 2, 3, 4, 5].map((value) => scopeColorRatio(value, 5))).toEqual([
    0, 0, 0.25, 0.5, 0.75, 1,
  ]);
  expect(scopeColorRatio(0, 0)).toBe(0);
  expect(scopeColorRatio(1, 1)).toBe(1);
  const vault = { id: "root" } as FileVault;
  expect(scopeCountKey({ vault, id: "stable", path: "before" })).toBe(
    scopeCountKey({ vault, id: "stable", path: "after" }),
  );
  expect(scopeCountKey({ vault, path: "stable" })).not.toBe(
    scopeCountKey({ vault, id: "stable" }),
  );
});
