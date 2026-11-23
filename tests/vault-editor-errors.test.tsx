// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  VaultSQLView,
  ExtensionDocumentView,
} from "../packages/app-ui/vault-extra-views";
import { FileExtensionHost } from "../packages/platform/src/file-sdk/host";
import { registerBundledFileExtensions } from "../packages/app-ui/vault-extensions";
import type { ExtensionDocument } from "../packages/platform/src/file-sdk";
import type { VaultRuntime } from "../packages/platform-browser/vault-runtime";
import { newCSDB } from "../packages/app-ui/vault-csdb-editor";
import { validateCSDBType } from "../packages/core/vaults/csdb";
import { contentTypes } from "../packages/core/vaults/content-types";
// The isolated iframe transport is covered in the real-browser extension checks.
vi.mock("../packages/app-ui/vault-extension-webview", () => ({
  ExtensionWebview: () => <div>Isolated webview</div>,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
async function show(node: ReactNode) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(node));
}
it("renders exact bigint SQL results and keeps SELECT from changing the file draft", async () => {
  const source = `--- csdb\nformat: CSDB\nversion: 2\nname: imported_tasks\nschemas: [public]\ntables: [public.tasks]\n\n--- schema:public\nname: public\ntypes: {}\n\n--- table:public:tasks\nschema: public\nname: tasks\ncolumns: {id: text, revision: bigint}\n\n--- data:tasks\nid,revision\na,9223372036854775807\n`;
  const onChange = vi.fn();
  await show(<VaultSQLView value={source} onChange={onChange} />);
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(
    document.querySelector('[aria-label="SQL result"]')!.textContent,
  ).toContain('"9223372036854775807"');
  expect(onChange).not.toHaveBeenCalled();
});

it("opens a bundled component as an alternate document view through the host", async () => {
  const doc: ExtensionDocument = {
    vault: "v",
    id: "f",
    path: "tasks.csdb",
    mime: "application/vnd.csdb",
    contentType: null,
    text: newCSDB(contentTypes.find((t) => t.id === "jocki.task-list")),
    bytes: new Uint8Array(),
    dirty: false,
    version: 1,
  };
  const extensions = new FileExtensionHost({
    folders: () => [],
    documents: () => [doc],
    updateDocument: async () => {},
    getConfiguration: () => undefined,
    updateConfiguration: async () => {},
  });
  registerBundledFileExtensions(extensions);
  const runtime = {
    extensions,
    editors: { snapshot: () => doc },
  } as unknown as VaultRuntime;
  await show(
    <ExtensionDocumentView
      runtime={runtime}
      file={doc}
      editor="core.csdb.editor"
      revision={0}
      renderComponent={(component) => <div>Component: {component}</div>}
    />,
  );
  expect(document.body.textContent).toContain("Component: csdb");
  doc.contentType = "jocki.task-list";
  await show(
    <ExtensionDocumentView
      runtime={runtime}
      file={doc}
      editor="tasks.editor"
      revision={1}
      renderComponent={(component) => <div>Component: {component}</div>}
    />,
  );
  expect(document.body.textContent).toContain("Component: tasks");
  await extensions.dispose();
});

it("creates valid generic and specialized CSDB files and explains incompatible task columns", () => {
  for (const type of [
    undefined,
    ...contentTypes.filter((t) => t.mimeTypes.includes("application/vnd.csdb")),
  ])
    expect(() => validateCSDBType(newCSDB(type), type)).not.toThrow();
  const imported = newCSDB(
    contentTypes.find((t) => t.id === "jocki.task-list"),
  ).replaceAll("id", "_record_id");
  expect(() =>
    validateCSDBType(
      imported,
      contentTypes.find((t) => t.id === "jocki.task-list"),
    ),
  ).toThrow("requires the column public.tasks.id (text)");
  expect(() => validateCSDBType(imported)).not.toThrow();
});
