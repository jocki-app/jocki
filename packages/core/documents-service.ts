import type { DocHandle } from "@automerge/automerge-repo";
import type {
  DocumentsService,
  PluginSchemaDocument,
} from "@jocki/platform/plugin-sdk/documents";
import type { WorkspaceNode } from "./device";
import { invariant } from "@jocki/platform/core/errors";
/** The plugin chooses a kind and ID for each first-level document. */
export function documentsService(
  node: WorkspaceNode,
  pluginId: string,
): DocumentsService {
  const replica = node.replica;
  const validSchema = (schemaId: string) => {
    const schema = node.records.get(schemaId);
    invariant(
      schema?.collection === "item_schemas" && !schema.deletedAt,
      "INVALID_SCHEMA",
      "Choose an existing workspace schema",
    );
  };
  const editable = () =>
    invariant(
      node.records.canWrite(),
      "PERMISSION_DENIED",
      "Workspace is read only",
    );
  const view = <T>(handle: DocHandle<T>) =>
    node.records.canWrite() ? handle : handle.view(handle.heads());
  return {
    repo: replica.access.repository.repo,
    defaultSchemaId: replica.graph.defaultSchemaId,
    index(schemaId) {
      return replica.editGraph(async () => {
        validSchema(schemaId);
        let handle = replica.graph.plugin(schemaId, pluginId);
        if (!handle) {
          editable();
          handle = await replica.graph.ensurePlugin(schemaId, pluginId);
        }
        return view(handle) as DocHandle<PluginSchemaDocument>;
      });
    },
    open<T extends Record<string, unknown>>(
      schemaId: string,
      kind: string,
      id: string,
      initial?: T,
    ) {
      invariant(
        /^[a-z][a-z0-9.-]{0,63}$/.test(kind) &&
          /^[a-zA-Z0-9_.:-]{1,256}$/.test(id),
        "INVALID_DOCUMENT",
        "Choose a document kind and stable item ID",
      );
      return replica.editGraph(async () => {
        validSchema(schemaId);
        const key = `state/${pluginId}/${schemaId}/${kind}/${id}`;
        let handle = replica.graph.item(key);
        if (!handle) {
          editable();
          invariant(initial, "NOT_FOUND", "This plugin item does not exist");
          handle = await replica.graph.ensureItem(key, initial, {
            schemaId,
            pluginId,
          });
        }
        return view(handle.sub("value") as unknown as DocHandle<T>);
      });
    },
    async list(schemaId, kind) {
      validSchema(schemaId);
      await replica.flush();
      const prefix = `state/${pluginId}/${schemaId}/`;
      return replica.ids(prefix).flatMap((key) => {
        const [type, id] = key.slice(prefix.length).split("/");
        return !kind || type === kind
          ? [
              {
                kind: type,
                id,
                url: view(replica.graph.item(key)!.sub("value")).url,
              },
            ]
          : [];
      });
    },
    flush: () => replica.flush(),
  };
}
