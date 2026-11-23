import * as A from "@automerge/automerge";
import type {
  AutomergeUrl,
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo";
import type {
  SchemaDocument,
  PluginSchemaDocument,
} from "@jocki/platform/plugin-sdk/documents";
import type { WorkspaceAccess, WorkspaceDocument } from "./membership";
import { invariant } from "@jocki/platform/core/errors";

export interface SharedSettingsDocument {
  format: "jocki-shared-settings";
  workspaceId: string;
  values: Record<string, Record<string, unknown>>;
}
export interface ItemDocument {
  format: "jocki-item";
  workspaceId: string;
  schemaId: string;
  pluginId: string;
  key: string;
  value: Record<string, unknown>;
}
type GraphDocument =
  | WorkspaceDocument
  | SchemaDocument
  | PluginSchemaDocument
  | SharedSettingsDocument
  | ItemDocument;

/** URL links form the hierarchy. Conflicting index links are all followed, so simultaneous
 * index creation on offline peers cannot discard either peer's newly created items. */
export function documentLinks(
  map: Record<string, AutomergeUrl>,
  key: string,
): AutomergeUrl[] {
  return [
    ...new Set([map[key], ...Object.values(A.getConflicts(map, key) ?? {})]),
  ].filter((value) => typeof value === "string") as AutomergeUrl[];
}
export function copy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof A.Counter) return new A.Counter(value.value) as T;
  if (value instanceof Uint8Array) return value.slice() as T;
  if (Array.isArray(value)) return value.map(copy) as T;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, copy(item)]),
  ) as T;
}
export class DocumentGraph {
  private handles = new Map<AutomergeUrl, DocHandle<any>>();
  private subscriptions = new Map<
    AutomergeUrl,
    (event: DocHandleChangePayload<any>) => void
  >();
  private schemaHandles = new Map<string, DocHandle<SchemaDocument>[]>();
  private pluginHandles = new Map<string, DocHandle<PluginSchemaDocument>[]>();
  private items = new Map<string, DocHandle<ItemDocument>[]>();
  private settings!: DocHandle<SharedSettingsDocument>;
  private refreshing?: Promise<void>;
  private ready = false;
  private structural = true;
  private loads = new AbortController();
  constructor(
    readonly access: WorkspaceAccess,
    private changed: (id: string) => void,
  ) {
    this.track(access.handle, "");
  }
  get workspaceId() {
    return this.access.handle.doc()!.id;
  }
  get defaultSchemaId() {
    return this.access.handle.doc()!.defaultSchemaId;
  }
  isReady() {
    return this.ready;
  }
  private track<T>(handle: DocHandle<T>, key: string) {
    if (this.handles.has(handle.url)) return handle;
    this.handles.set(handle.url, handle);
    const change = (event: DocHandleChangePayload<T>) => {
      if (!key) {
        this.structural = true;
        if (
          (event.doc as unknown as PluginSchemaDocument)?.format ===
          "jocki-plugin-schema"
        ) {
          const keys = event.patches.flatMap((patch) =>
            patch.path[0] === "items" && typeof patch.path[1] === "string"
              ? [patch.path[1]]
              : [],
          );
          if (keys.length) {
            for (const key of new Set(keys)) this.changed(key);
            return;
          }
        }
      }
      if (key !== "setting/") {
        this.changed(key);
        return;
      }
      // A shared-settings document holds several logical entries. Patches
      // identify the entries to invalidate without rewriting every setting.
      const keys = new Set(
        event.patches.flatMap((patch) =>
          patch.path[0] === "values" && typeof patch.path[1] === "string"
            ? [patch.path[1]]
            : [],
        ),
      );
      if (!keys.size) {
        const before = event.patchInfo
            .before as unknown as SharedSettingsDocument,
          after = event.patchInfo.after as unknown as SharedSettingsDocument;
        for (const key of [
          ...Object.keys(before.values ?? {}),
          ...Object.keys(after.values ?? {}),
        ])
          keys.add(key);
      }
      for (const key of keys) this.changed(key);
    };
    this.subscriptions.set(handle.url, change);
    handle.on("change", change);
    return handle;
  }
  private async load<T extends GraphDocument>(url: AutomergeUrl, key = "") {
    const known = this.handles.get(url);
    if (known) return known as DocHandle<T>;
    const handle = await this.access.repository.load<T>(
      url,
      AbortSignal.any([this.loads.signal, AbortSignal.timeout(30000)]),
    );
    invariant(
      (handle.doc() as { workspaceId?: string })?.workspaceId ===
        this.workspaceId,
      "INVALID_WORKSPACE",
      "Document belongs to another workspace",
    );
    return this.track(handle, key);
  }
  refresh() {
    if (this.ready && !this.structural && !this.refreshing)
      return Promise.resolve();
    return (this.refreshing ??= (async () => {
      do {
        this.structural = false;
        await this.readGraph();
      } while (this.structural);
    })()
      .catch((error) => {
        this.structural = true;
        throw error;
      })
      .finally(() => {
        this.refreshing = undefined;
      }));
  }
  private async readGraph() {
    const root = this.access.handle.doc()!;
    const settings = await this.load<SharedSettingsDocument>(
      root.sharedSettings,
      "setting/",
    );
    invariant(
      settings.doc()?.format === "jocki-shared-settings",
      "INVALID_WORKSPACE",
      "Invalid shared settings document",
    );
    const schemas = new Map<string, DocHandle<SchemaDocument>[]>(),
      plugins = new Map<string, DocHandle<PluginSchemaDocument>[]>(),
      items = new Map<string, DocHandle<ItemDocument>[]>();
    const visited = new Set<AutomergeUrl>([
      root.sharedSettings,
      this.access.handle.url,
    ]);
    for (const schemaId of Object.keys(root.schemas)) {
      const schemaDocs = await Promise.all(
        documentLinks(root.schemas, schemaId).map((url) =>
          this.load<SchemaDocument>(url),
        ),
      );
      schemas.set(schemaId, schemaDocs);
      for (const schema of schemaDocs) {
        const doc = schema.doc()!;
        invariant(
          doc.format === "jocki-schema" && doc.schemaId === schemaId,
          "INVALID_WORKSPACE",
          "Invalid schema index",
        );
        visited.add(schema.url);
        for (const pluginId of Object.keys(doc.plugins)) {
          const pluginDocs = await Promise.all(
            documentLinks(doc.plugins, pluginId).map((url) =>
              this.load<PluginSchemaDocument>(url),
            ),
          );
          const key = schemaId + "/" + pluginId;
          plugins.set(key, [
            ...new Set([...(plugins.get(key) ?? []), ...pluginDocs]),
          ]);
          for (const plugin of pluginDocs) {
            const index = plugin.doc()!;
            invariant(
              index.format === "jocki-plugin-schema" &&
                index.schemaId === schemaId &&
                index.pluginId === pluginId,
              "INVALID_WORKSPACE",
              "Invalid plugin/schema index",
            );
            if (visited.has(plugin.url)) continue;
            visited.add(plugin.url);
            const links = Object.keys(index.items).flatMap((key) =>
              documentLinks(index.items, key).map((url) => ({ key, url })),
            );
            for (let offset = 0; offset < links.length; offset += 16) {
              await Promise.all(
                links.slice(offset, offset + 16).map(async ({ key, url }) => {
                  const item = await this.load<ItemDocument>(url, key),
                    value = item.doc()!;
                  invariant(
                    value.format === "jocki-item" &&
                      value.schemaId === schemaId &&
                      value.pluginId === pluginId &&
                      value.key === key,
                    "INVALID_WORKSPACE",
                    "Invalid item document",
                  );
                  items.set(
                    key,
                    [...new Set([...(items.get(key) ?? []), item])].sort(
                      (a, b) => a.url.localeCompare(b.url),
                    ),
                  );
                  visited.add(url);
                }),
              );
            }
          }
        }
      }
    }
    // Every surviving index branch receives the union. References to older branches
    // remain valid while peers finish offline writes; no child is hidden by an index conflict.
    for (const group of plugins.values())
      await this.combineLinks(group, "items");
    for (const group of schemas.values())
      await this.combineLinks(group, "plugins");
    if (this.ready)
      for (const key of new Set([...this.items.keys(), ...items.keys()]))
        if (
          this.primary(this.items.get(key))?.url !==
          this.primary(items.get(key))?.url
        )
          this.changed(key);
    this.schemaHandles = schemas;
    this.pluginHandles = plugins;
    this.items = items;
    this.settings = settings;
    for (const [url, handle] of this.handles) {
      if (visited.has(url)) continue;
      handle.off("change", this.subscriptions.get(url)!);
      this.subscriptions.delete(url);
      this.handles.delete(url);
    }
    this.ready = true;
  }
  private async combineLinks(
    handles: DocHandle<any>[],
    field: "items" | "plugins",
  ) {
    if (handles.length < 2) return;
    const combined = new Map<string, AutomergeUrl>();
    for (const handle of handles) {
      const links = handle.doc()[field] as Record<string, AutomergeUrl>;
      for (const key of Object.keys(links)) {
        for (const url of documentLinks(links, key)) {
          if (!combined.has(key) || url < combined.get(key)!)
            combined.set(key, url);
        }
      }
    }
    for (const handle of handles) {
      const missing = [...combined].filter(
        ([key]) => !(key in handle.doc()[field]),
      );
      if (!missing.length) continue;
      const access = await this.access.repository.hive.bestAccessForDoc(
        this.access.repository.hive.active.individual.id,
        handle.url,
      );
      if (access?.isEditor)
        handle.change(
          (doc: Record<typeof field, Record<string, AutomergeUrl>>) => {
            for (const [key, url] of missing) doc[field][key] = url;
          },
        );
    }
  }
  private primary<T>(handles: DocHandle<T>[] | undefined) {
    return handles?.slice().sort((a, b) => a.url.localeCompare(b.url))[0];
  }
  item(key: string) {
    return this.primary(this.items.get(key));
  }
  sharedSettings() {
    return this.settings;
  }
  ids(prefix = "") {
    const settings = Object.keys(this.settings?.doc()?.values ?? {});
    return [...this.items.keys(), ...settings].filter((key) =>
      key.startsWith(prefix),
    );
  }
  read<T = Record<string, unknown>>(key: string): T | undefined {
    const value =
      this.settings?.doc()?.values[key] ?? this.item(key)?.doc()?.value;
    return value ? (copy(value) as T) : undefined;
  }
  target(key: string) {
    const settings = this.settings?.doc()!.values ?? {};
    return key in settings ? settings[key] : this.item(key)?.doc()?.value;
  }
  heads(key: string) {
    if (!key)
      return this.sharedHandles()
        .flatMap((handle) => A.getHeads(handle.doc()!))
        .sort();
    if (key in (this.settings?.doc()!.values ?? {}))
      return A.getHeads(this.settings.doc()!);
    return this.item(key)?.heads() ?? [];
  }
  source(key: string) {
    return key in (this.settings?.doc()?.values ?? {})
      ? this.settings.url
      : this.item(key)?.url;
  }
  sharedHandles() {
    return [...this.handles.values()];
  }
  async ensureSchema(schemaId: string) {
    const known = this.primary(this.schemaHandles.get(schemaId));
    if (known) return known;
    const handle = await this.access.repository.createGrouped<SchemaDocument>(
      {
        format: "jocki-schema",
        workspaceId: this.workspaceId,
        schemaId,
        plugins: {},
      },
      this.access.handle.doc()!.accessGroup,
    );
    this.track(handle, "");
    this.schemaHandles.set(schemaId, [handle]);
    this.access.handle.change((doc) => {
      doc.schemas[schemaId] = handle.url;
    });
    await this.access.repository.flush();
    return handle;
  }
  plugin(schemaId: string, pluginId: string) {
    return this.primary(this.pluginHandles.get(schemaId + "/" + pluginId));
  }
  async ensurePlugin(schemaId: string, pluginId: string) {
    const known = this.primary(
      this.pluginHandles.get(schemaId + "/" + pluginId),
    );
    if (known) return known;
    const schema = await this.ensureSchema(schemaId);
    const handle =
      await this.access.repository.createGrouped<PluginSchemaDocument>(
        {
          format: "jocki-plugin-schema",
          workspaceId: this.workspaceId,
          schemaId,
          pluginId,
          items: {},
        },
        this.access.handle.doc()!.accessGroup,
      );
    this.track(handle, "");
    this.pluginHandles.set(schemaId + "/" + pluginId, [handle]);
    schema.change((doc) => {
      doc.plugins[pluginId] = handle.url;
    });
    await this.access.repository.flush();
    return handle;
  }
  location(key: string, value: Record<string, unknown>) {
    if (key.startsWith("record/")) {
      const data = value.data as Record<string, unknown>;
      const table = data?.table_id
        ? this.read<any>("record/" + data.table_id)
        : undefined;
      const schemaId =
        value.collection === "item_schemas"
          ? String(value.id)
          : String(
              data?.schema_id ?? table?.data.schema_id ?? this.defaultSchemaId,
            );
      return { schemaId, pluginId: String(value.pluginId) };
    }
    return {
      schemaId: this.defaultSchemaId,
      pluginId:
        key.startsWith("file/") || key.startsWith("blob/")
          ? "files"
          : key.startsWith("vault/")
            ? "credentials"
            : "records",
    };
  }
  async ensureItem(
    key: string,
    value: Record<string, unknown>,
    location = this.location(key, value),
  ) {
    const known = this.item(key);
    if (known) return known;
    const parent = await this.ensurePlugin(
      location.schemaId,
      location.pluginId,
    );
    const handle = await this.access.repository.createGrouped<ItemDocument>(
      {
        format: "jocki-item",
        workspaceId: this.workspaceId,
        ...location,
        key,
        value: copy(value),
      },
      this.access.handle.doc()!.accessGroup,
    );
    this.track(handle, key);
    this.items.set(key, [handle]);
    // Persist the child and its group grant before publishing the link.
    parent.change((doc) => {
      doc.items[key] = handle.url;
    });
    await this.access.repository.flush();
    return handle;
  }
  cancelLoads() {
    this.loads.abort(new Error("Workspace is closing"));
  }
  stop() {
    this.cancelLoads();
    for (const [url, handle] of this.handles)
      handle.off("change", this.subscriptions.get(url)!);
    this.subscriptions.clear();
  }
}
