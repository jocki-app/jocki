import * as A from "@automerge/automerge";
import {
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import { Bundle, exportBundle } from "@automerge/automerge-repo-bundles";
import type {
  SchemaDocument,
  PluginSchemaDocument,
} from "@jocki/platform/plugin-sdk/documents";
import type { WorkspaceNode, DeviceCore } from "./device";
import type { WorkspaceDocument } from "./membership";
import {
  documentLinks,
  copy,
  type ItemDocument,
  type SharedSettingsDocument,
} from "./document-graph";
import { invariant } from "@jocki/platform/core/errors";
/** Export exactly the shared graph. Private computer settings, Keyhive keys and secret documents are excluded. */
export async function exportWorkspace(node: WorkspaceNode) {
  await node.replica.flush();
  return exportBundle(
    node.replica.access.repository.repo,
    node.replica.graph.sharedHandles(),
  ).encode();
}
/** Import creates a new graph and new authority, never a connection to the exporting workspace. */
export async function importWorkspace(device: DeviceCore, bytes: Uint8Array) {
  invariant(
    bytes.length <= 512 * 1024 * 1024,
    "PAYLOAD_TOO_LARGE",
    "Workspace bundle exceeds 512 MB",
  );
  const bundle = Bundle.decode(bytes);
  const documents = new Map<AutomergeUrl, any>();
  for (const [id, entry] of bundle.docs)
    documents.set(stringifyAutomergeUrl(id), A.load(entry.data));
  const roots = [...documents.values()].filter(
    (doc) => doc.format === "jocki-workspace",
  ) as WorkspaceDocument[];
  invariant(
    roots.length === 1,
    "INVALID_WORKSPACE",
    "Choose a bundle containing one current Jocki workspace",
  );
  const root = roots[0],
    visited = new Set<AutomergeUrl>();
  const load = <T>(url: AutomergeUrl, format: string): T => {
    const doc = documents.get(url);
    invariant(
      doc?.format === format && doc.workspaceId === root.id,
      "INVALID_WORKSPACE",
      "Bundle contains a missing or unrelated document",
    );
    visited.add(url);
    return doc;
  };
  const settings = load<SharedSettingsDocument>(
    root.sharedSettings,
    "jocki-shared-settings",
  );
  const items: ItemDocument[] = [];
  for (const schemaId of Object.keys(root.schemas))
    for (const url of documentLinks(root.schemas, schemaId)) {
      const schema = load<SchemaDocument>(url, "jocki-schema");
      invariant(
        schema.schemaId === schemaId,
        "INVALID_WORKSPACE",
        "Schema link does not match its document",
      );
      for (const pluginId of Object.keys(schema.plugins))
        for (const url of documentLinks(schema.plugins, pluginId)) {
          const plugin = load<PluginSchemaDocument>(
            url,
            "jocki-plugin-schema",
          );
          invariant(
            plugin.schemaId === schemaId && plugin.pluginId === pluginId,
            "INVALID_WORKSPACE",
            "Plugin link does not match its document",
          );
          for (const key of Object.keys(plugin.items))
            for (const url of documentLinks(plugin.items, key)) {
              const item = load<ItemDocument>(url, "jocki-item");
              invariant(
                item.key === key &&
                  item.schemaId === schemaId &&
                  item.pluginId === pluginId,
                "INVALID_WORKSPACE",
                "Item link does not match its document",
              );
              items.push(item);
            }
        }
    }
  invariant(
    visited.size + 1 === documents.size,
    "INVALID_WORKSPACE",
    "Bundle contains documents outside its shared workspace graph",
  );
  const node = await device.createWorkspace(root.name, undefined, undefined, {
    seed: false,
    defaultSchemaId: root.defaultSchemaId,
  });
  for (const [key, value] of Object.entries(settings.values))
    await node.replica.update(key, copy(value));
  const priority = (item: ItemDocument) =>
    ["item_schemas", "tables", "items"].indexOf(String(item.value.collection));
  items.sort(
    (a, b) =>
      (priority(a) < 0 ? 3 : priority(a)) - (priority(b) < 0 ? 3 : priority(b)),
  );
  for (const item of items) {
    const id = item.key;
    if (
      id.startsWith("vault/") ||
      id.startsWith("setting/service.") ||
      id.startsWith("setting/service-release.") ||
      id.startsWith("job/")
    )
      continue;
    const value = copy(item.value);
    if (id.startsWith("record/")) {
      value.workspaceId = node.replica.workspaceId;
      value.ownerId = node.replica.member.userId;
      if (value.collection === "devices") continue;
      if (value.collection === "workflows")
        value.data = {
          ...(value.data as object),
          enabled: false,
          target_device_id: null,
        };
      if (value.collection === "credentials")
        value.data = {
          ...(value.data as object),
          status: "needs-authorization",
        };
    }
    await node.replica.update(id, value, [], {
      schemaId: item.schemaId,
      pluginId: item.pluginId,
    });
  }
  await node.replica.flush();
  return node;
}
