import { expect, it } from "vitest";
import { registerCoreMenus } from "../packages/app-ui/core-menus";
import { UIContributionRegistry } from "../packages/platform/src/file-sdk/ui-registry";

it("offers one action for each feature using the effective scope settings", () => {
  const registry = new UIContributionRegistry();
  registerCoreMenus(registry, [], [], []);
  for (const location of [
    "explorer/context",
    "editor/toolbar",
    "workspace/context",
  ] as const)
    for (const history of [false, true])
      for (const sync of [false, true]) {
        const actions = registry.items(location, {
          kind: location === "workspace/context" ? "workspace" : "file",
          history,
          sync,
        });
        expect(
          actions
            .filter((action) => action.command === "core.history")
            .map((action) => action.title),
        ).toEqual([history ? "History" : "Enable history"]);
        expect(
          actions
            .filter((action) => action.command === "core.share")
            .map((action) => action.title),
        ).toEqual([sync ? "Sharing" : "Enable sharing"]);
        expect(
          actions.some((action) =>
            /History and sharing|Remove history|Share workspace/.test(
              action.title,
            ),
          ),
        ).toBe(false);
      }
});
