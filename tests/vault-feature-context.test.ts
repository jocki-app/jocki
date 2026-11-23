import { expect, it } from "vitest";
import {
  featureAncestors,
  featureState,
} from "../packages/app-ui/vault-feature-model";
import { FileVault } from "../packages/core/vaults/vault";
import { WorkspaceStore } from "../packages/core/vaults/workspace";
import type { VaultRuntime } from "../packages/platform-browser/vault-runtime";
import { CompanionFiles } from "./fixtures/companion-files";
import { utf8 } from "../packages/core/crypto";

async function setup() {
  const vault = await FileVault.open(new CompanionFiles(), "one");
  const id = await vault.create("parent/deep/note.md", utf8.encode("note"));
  await vault.create("other/sibling.md", utf8.encode("sibling"));
  const workspace = await WorkspaceStore.open(new CompanionFiles(), "one");
  return { vault, id, runtime: { workspace } as VaultRuntime };
}
it("always includes every potential ancestor within the mounted boundary and no siblings", async () => {
  const { vault, id } = await setup();
  const paths = () =>
    featureAncestors({ vault, id }).map((target) => target.path);
  expect(paths()).toEqual([undefined, "", "parent", "parent/deep"]);
  await vault.configureScope("folder", "parent", { history: true });
  await vault.configureScope("folder", "parent/deep", { history: false });
  await vault.configureScope("file", id, { history: true });
  expect(paths()).toEqual([undefined, "", "parent", "parent/deep"]);
  expect(featureAncestors({ vault, path: "" })).toEqual([{}]);
  expect(featureAncestors({})).toEqual([]);
});
it.each(["history", "sync"] as const)(
  "preserves every ancestor's %s setting regardless of lower overrides",
  async (feature) => {
    const { vault, id, runtime } = await setup();
    await runtime.workspace.configure({ [feature]: true });
    await vault.inheritFeatures(runtime.workspace.features);
    await vault.configureScope("folder", "parent", { [feature]: false });
    const ancestorColors = () =>
      featureAncestors({ vault, id }).map((ancestor) =>
        featureState(runtime, ancestor, feature),
      );
    const expected = [
      { state: "enabled", tone: "enabled" },
      { state: "inherited", tone: "enabled" },
      { state: "disabled", tone: "disabled" },
      { state: "inherited", tone: "disabled" },
    ];
    expect(ancestorColors()).toEqual(expected);
    await vault.configureScope("file", id, { [feature]: true });
    expect(ancestorColors()).toEqual(expected);
    await vault.configureScope("file", id, { [feature]: false });
    expect(ancestorColors()).toEqual(expected);
  },
);

it.each(["history", "sync"] as const)(
  "resolves inherited %s policies from the closest explicit true or false setting",
  async (feature) => {
    const { vault, id, runtime } = await setup();
    const target = { vault, id };
    expect(featureState(runtime, target, feature)).toEqual({
      state: "off",
      tone: "off",
    });
    await runtime.workspace.configure({ [feature]: false });
    expect(featureState(runtime, target, feature)).toEqual({
      state: "inherited",
      tone: "disabled",
    });
    await vault.configureScope("vault", "", { [feature]: true });
    expect(featureState(runtime, target, feature)).toEqual({
      state: "inherited",
      tone: "enabled",
    });
    await vault.configureScope("folder", "parent/deep", { [feature]: false });
    expect(featureState(runtime, target, feature)).toEqual({
      state: "inherited",
      tone: "disabled",
    });
    await vault.configureScope("file", id, { [feature]: true });
    expect(featureState(runtime, target, feature)).toEqual({
      state: "enabled",
      tone: "enabled",
    });
    await vault.configureScope("file", id, { [feature]: undefined });
    expect(featureState(runtime, target, feature)).toEqual({
      state: "inherited",
      tone: "disabled",
    });
  },
);
