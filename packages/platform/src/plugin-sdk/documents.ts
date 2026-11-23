import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";

export interface SchemaDocument {
  format: "jocki-schema";
  workspaceId: string;
  schemaId: string;
  plugins: Record<string, AutomergeUrl>;
}
export interface PluginSchemaDocument {
  format: "jocki-plugin-schema";
  workspaceId: string;
  schemaId: string;
  pluginId: string;
  items: Record<string, AutomergeUrl>;
}
/** A plugin chooses an item's kind, ID and contents, e.g. a task, page or timer. */
export interface DocumentItem {
  id: string;
  kind: string;
  url: AutomergeUrl;
}
/** Native handles; each item is an independent Repo document. Await flush before reporting saved writes. */
export interface DocumentsService {
  readonly repo: Repo;
  readonly defaultSchemaId: string;
  index(schemaId: string): Promise<DocHandle<PluginSchemaDocument>>;
  open<T extends Record<string, unknown>>(
    schemaId: string,
    kind: string,
    id: string,
    initial?: T,
  ): Promise<DocHandle<T>>;
  list(schemaId: string, kind?: string): Promise<DocumentItem[]>;
  flush(): Promise<void>;
}
