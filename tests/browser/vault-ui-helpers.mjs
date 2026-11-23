export async function createVaultFile(
  page,
  vault,
  name,
  type = "Markdown",
  folder = "",
) {
  await page
    .getByRole("button", {
      name: `Actions for ${folder || vault}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "New file", exact: true }).hover();
  await page.getByRole("menuitem", { name: type, exact: true }).click();
  const input = page.getByRole("textbox", { name: "File name", exact: true });
  await input.fill(name);
  await input.press("Enter");
}
export async function documentAction(page, name) {
  await page
    .locator("[data-document-toolbar]")
    .filter({ visible: true })
    .getByRole("button", { name, exact: true })
    .click();
}
export async function skipVaultSetup(page) {
  await page
    .getByRole("dialog", { name: "Add a templates folder?", exact: true })
    .waitFor();
  // Named folder, Note, Task list, and the two workout templates.
  for (let index = 0; index < 5; index++)
    await page.getByRole("button", { name: "Skip", exact: true }).click();
}
/** Simulate an external writer; file import UI is intentionally absent. */
export async function writeVaultFiles(page, vault, files, folder = "") {
  const rootName = await internalVaultDirectory(page, vault);
  await page.evaluate(
    async ({ rootName, files, folder }) => {
      const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki");
      const root = await app.getDirectoryHandle(rootName);
      for (const file of files) {
        if (file.record) {
          const { Companions } =
            await import("/packages/core/vaults/companions.ts");
          const { BrowserVaultFiles } =
            await import("/packages/platform-browser/vault-files.ts");
          await new Companions(new BrowserVaultFiles(root)).write(
            [folder, file.name].filter(Boolean).join("/"),
            file.record,
            new Uint8Array(file.bytes),
          );
          continue;
        }
        let destination = root;
        const parts = [folder, file.name].filter(Boolean).join("/").split("/");
        for (const name of parts.slice(0, -1))
          destination = await destination.getDirectoryHandle(name, {
            create: true,
          });
        const writer = await (
          await destination.getFileHandle(parts.at(-1), { create: true })
        ).createWritable();
        await writer.write(new Uint8Array(file.bytes));
        await writer.close();
      }
      window.dispatchEvent(new Event("focus"));
    },
    {
      rootName,
      folder,
      files: files.map((file) => ({
        name: file.name,
        record: file.record,
        bytes: [...file.buffer],
      })),
    },
  );
}

/** Desktop and web always start without an open workspace. */
export async function createWorkspace(page, name = "Workspace") {
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Workspace name", exact: true })
    .fill(name);
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose workspace", exact: true })
    .waitFor();
}
export async function openSavedWorkspace(page, name = "Workspace") {
  await page.locator("[data-start-screen]").waitFor();
  const manage = page.getByRole("button", { name: "Manage", exact: true });
  if (await manage.isVisible()) await manage.click();
  await page
    .getByRole("combobox", { name: "Saved workspaces", exact: true })
    .click();
  await page.getByRole("option", { name, exact: true }).click();
  await page
    .getByRole("button", { name: "Open workspace", exact: true })
    .click();
}

/** Resolve internal folders through workspace references, never a central vault manifest. */
export async function internalVaultDirectory(page, name) {
  return page.evaluate(async (name) => {
    const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki"),
      storage = await app.getDirectoryHandle("workspace");
    const catalog = JSON.parse(
      await (
        await (await storage.getFileHandle("workspaces.json")).getFile()
      ).text(),
    );
    for (const entry of catalog.entries) {
      if (entry.kind !== "internal") continue;
      let root = storage;
      for (const part of entry.root.split("/").filter(Boolean))
        root = await root.getDirectoryHandle(part);
      const doc = JSON.parse(
        await (
          await (await root.getFileHandle("workspace.json")).getFile()
        ).text(),
      );
      const id = Object.keys(doc.defaults.rootNames).find(
        (id) => doc.defaults.rootNames[id] === name,
      );
      if (!id) continue;
      const location =
        Object.values(doc.computers)
          .map((computer) => computer.vaults?.[id])
          .find(Boolean) ?? doc.defaults.vaults[id];
      if (!location?.startsWith("internal:"))
        throw Error("Expected an internal folder");
      return location.slice(9);
    }
    throw Error("Internal folder not found: " + name);
  }, name);
}
