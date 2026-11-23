import * as Timers from "@jocki/platform/core/timers";
import * as Optimistic from "../ui/optimistic";
import * as Notifications from "../ui/notifications";
import * as References from "@jocki/platform/core/field-references";
import * as CollectionTables from "@jocki/platform/core/collection-tables";
import { ExecutionTarget } from "./execution-target";
import { scopedTableStore } from "./collection-tables";
import * as Execution from "@jocki/platform/plugin-sdk/execution";
import * as AlertDialog from "../ui/primitives/alert-dialog";
import * as CalendarUI from "../ui/primitives/calendar";
import * as Card from "../ui/primitives/card";
import * as Command from "../ui/primitives/command";
import * as Sheet from "../ui/primitives/sheet";
import * as Collapsible from "../ui/primitives/collapsible";
import * as DropdownMenu from "../ui/primitives/dropdown-menu";
import * as InputGroup from "../ui/primitives/input-group";
import * as Label from "../ui/primitives/label";
import * as ScrollArea from "../ui/primitives/scroll-area";
import * as Separator from "../ui/primitives/separator";
import * as Sonner from "../ui/primitives/sonner";
import * as Switch from "../ui/primitives/switch";
import * as Tabs from "../ui/primitives/tabs";
import * as Toggle from "../ui/primitives/toggle";
import * as React from "react";
import * as ReactDOM from "react-dom";
import {
  sharedReact,
  sharedJsxRuntime,
  sharedJsxDevRuntime,
} from "../ui/html-controls";
import * as QueryControls from "../ui/query-controls";
import * as ValueCombobox from "../ui/value-combobox";
import * as ChoiceSelect from "../ui/choice-select";
import * as CollectionView from "../ui/collection-view";
import * as CollectionModel from "../ui/collection-view-model";
import * as CalendarModel from "../ui/calendar-model";
import * as CalendarView from "../ui/calendar-view";
import * as CollectionDrag from "../ui/collection-drag";
import * as EditActions from "../ui/edit-actions";
import * as Popover from "../ui/primitives/popover";
import * as Combobox from "../ui/primitives/combobox";
import * as Breadcrumb from "../ui/primitives/breadcrumb";
import * as Checkbox from "../ui/primitives/checkbox";
import * as Textarea from "../ui/primitives/textarea";
import * as StorageReact from "../data-duckdb/react";
import * as Fields from "../ui/fields";
import * as ColumnsTable from "../ui/columns-table";
import * as ColumnEditor from "../ui/column-editor";
import * as Button from "../ui/primitives/button";
import * as LoadingSpinner from "../ui/loading-spinner";
import * as ButtonGroup from "../ui/primitives/button-group";
import * as Input from "../ui/primitives/input";
import * as Dialog from "../ui/primitives/dialog";
import * as Select from "../ui/primitives/select";
import * as Table from "../ui/primitives/table";
import * as Badge from "../ui/primitives/badge";
import * as Download from "./download";
import * as FieldTypes from "@jocki/platform/field-types";
import * as Catalog from "@jocki/platform/core/catalog";
import * as Calendar from "@jocki/platform/core/calendar";
import * as CalendarValues from "@jocki/platform/core/calendar-values";
import * as Workflows from "@jocki/platform/core/workflows";
import { RecordTable } from "./record-table";
import { invariant } from "@jocki/platform/core/errors";
import type { AppRuntime } from "./runtime";
import type {
  PluginManifest,
  ResourceRecord,
} from "@jocki/platform/plugin-sdk";

export function pluginWorkspace(
  runtime: AppRuntime,
  manifest: PluginManifest,
  grants: string[],
) {
  const active = () => {
    runtime.assertActive();
    invariant(
      runtime.registry.enabled(manifest.id),
      "FEATURE_DISABLED",
      "Plugin is disabled",
    );
  };
  const service = (id: string) => {
    active();
    const declaration = manifest.sharedServices.find((s) => s.id === id);
    invariant(
      declaration &&
        grants.includes(id) &&
        (!declaration.when ||
          runtime.registry.states
            .get(manifest.id)
            ?.features.includes(declaration.when)),
      "PERMISSION_DENIED",
      `Declare and enable ${id}`,
    );
  };
  const allowed = (name: string, action = "list") => {
    active();
    const schema = Catalog.getSchema(name);
    invariant(
      runtime.registry.enabled(schema.pluginId),
      "FEATURE_DISABLED",
      "The collection provider is disabled",
    );
    invariant(
      schema.pluginId === manifest.id ||
        (manifest.consumes.commands.includes(`${name}.${action}`) &&
          grants.includes(`${name}.${action}`)),
      "UNDECLARED_COLLECTION",
      "Declare cross-plugin commands before using this collection",
    );
  };
  const facade = {
    profile: Object.freeze({ ...runtime.profile }),
    principal: Object.freeze({ ...runtime.principal, pluginId: manifest.id }),
    optimistic: {
      subscribe: runtime.optimistic.subscribe,
      snapshot: runtime.optimistic.snapshot,
      count: (id: string) => {
        active();
        const record = runtime.optimistic.record(id);
        if (record) allowed(record.collection);
        return runtime.optimistic.count(id);
      },
    },
    get registry() {
      return {
        enabled: (id: string) => runtime.registry.enabled(id),
        states: new Map(
          [...runtime.registry.states].map(([id, state]) => [
            id,
            structuredClone(state),
          ]),
        ),
      };
    },
    collection: (name: string) => {
      allowed(name);
      const owned = Catalog.getSchema(name).pluginId === manifest.id;
      const call = async (action: string, input: unknown) => {
        allowed(name, action);
        const result = await runtime.callPluginCommand(
          manifest.id,
          `${name}.${action}`,
          input,
        );
        return result;
      };
      if (owned) {
        const rawStore = runtime.db
          .scoped(
            facade.principal,
            manifest.id,
            runtime.profile.connected ? "synced" : "local-only",
          )
          .collection(name);
        const store = runtime.optimisticStore(name, rawStore, manifest.id);
        return scopedTableStore(runtime, name, {
          list: (query?: Parameters<typeof store.list>[0]) => {
            allowed(name);
            return store.list(query);
          },
          get: (id: string) => {
            allowed(name);
            return store.get(id);
          },
          put: (data: Parameters<typeof store.put>[0], id?: string) => {
            allowed(name, "put");
            return store.put(data, id);
          },
          delete: (id: string) => {
            allowed(name, "delete");
            return store.delete(id);
          },
        });
      }
      const store = runtime.optimisticStore(
        name,
        {
          list: (query?: unknown) =>
            call("list", query) as Promise<ResourceRecord[]>,
          get: async (id: string) => {
            allowed(name);
            const record = await runtime.db.records.get(id);
            return record?.collection === name &&
              record.workspaceId === runtime.profile.workspaceId
              ? record
              : undefined;
          },
          put: async (data: unknown, id: string = crypto.randomUUID()) => {
            const prior = await runtime.db.records.get(id);
            return call("put", {
              id: crypto.randomUUID(),
              resourceId: id,
              pluginId: Catalog.getSchema(name).pluginId,
              collection: name,
              operation: "put",
              baseRevision: prior?.revision ?? 0,
              data,
              createdAt: new Date().toISOString(),
            }) as Promise<ResourceRecord>;
          },
          delete: async (id: string) => {
            const prior = await runtime.db.records.get(id);
            return call("delete", {
              id: crypto.randomUUID(),
              resourceId: id,
              collection: name,
              pluginId: Catalog.getSchema(name).pluginId,
              operation: "delete",
              baseRevision: prior?.revision ?? 0,
              data: prior?.data ?? {},
              createdAt: new Date().toISOString(),
            });
          },
        },
        manifest.id,
      );
      return {
        list: (query?: Parameters<typeof store.list>[0]) => {
          allowed(name);
          return store.list(query);
        },
        get: (id: string) => {
          allowed(name);
          return store.get(id);
        },
        put: (data: Record<string, FieldTypes.Value>, id?: string) => {
          allowed(name, "put");
          return store.put(data, id);
        },
        delete: (id: string) => {
          allowed(name, "delete");
          return store.delete(id);
        },
      };
    },
    async api(path: string, body?: unknown, method?: string) {
      active();
      const pathname = path.split("?")[0];
      const owners = [
        manifest,
        ...manifest.dependencies
          .map((id) => runtime.registry.manifests.get(id))
          .filter(Boolean),
      ];
      const permitted = owners.some((owner) =>
        owner?.server?.routes.some((route) =>
          route.path.endsWith("*")
            ? pathname.startsWith(route.path.slice(0, -1))
            : pathname === route.path,
        ),
      );
      if (!permitted) {
        invariant(
          pathname.startsWith("access/"),
          "UNDECLARED_ROUTE",
          "Use a declared plugin route or core message",
        );
        service("core.access");
      }
      return runtime.api(path, body, method);
    },
    synchronize: () => {
      service("core.sync");
      return runtime.synchronize();
    },
    fileBytes: (id: string) => {
      service("files.access");
      return runtime.fileBytes(id);
    },
    db: {
      records: {
        get: async (id: string) => {
          active();
          const record = runtime.optimistic.record(
            id,
            await runtime.db.records.get(id),
          );
          if (record) allowed(record.collection);
          return record;
        },
        put: async (record: ResourceRecord) => {
          allowed(record.collection, "put");
          invariant(
            record.workspaceId === runtime.profile.workspaceId,
            "PERMISSION_DENIED",
            "Resource is outside this workspace",
          );
          return runtime
            .collection(record.collection)
            .put(record.data, record.id);
        },
        filter: (predicate: (record: ResourceRecord) => boolean) => {
          service("core.access");
          return {
            toArray: async () => {
              service("core.access");
              return runtime.optimistic
                .project(await runtime.db.records.toArray())
                .filter(
                  (r) =>
                    r.workspaceId === runtime.profile.workspaceId &&
                    predicate(r),
                );
            },
          };
        },
      },
      saveFile: (
        _principal: unknown,
        id: string,
        blob: Blob,
        parent: string | null,
      ) => {
        service("files.access");
        return runtime.db.saveFile(facade.principal, id, blob, parent);
      },
    },
  };
  return facade;
}
export function pluginModules(
  runtime: AppRuntime,
  manifest: PluginManifest,
  grants: string[],
) {
  const workspace = pluginWorkspace(runtime, manifest, grants);
  const allowed = (collection: string) =>
    invariant(
      manifest.storage.local.collections.includes(collection) ||
        (manifest.consumes.commands.includes(collection + ".list") &&
          grants.includes(collection + ".list")),
      "UNDECLARED_COLLECTION",
      "Declare the collection used by this table",
    );
  return {
    react: { ...sharedReact, default: sharedReact },
    "react/jsx-runtime": sharedJsxRuntime,
    "react/jsx-dev-runtime": sharedJsxDevRuntime,
    "react-dom": ReactDOM,
    "@jocki/ui/storage": StorageReact,
    // Existing plugin module name; the implementation is entirely backed by core DuckDB.
    "dexie-react-hooks": StorageReact,
    "@jocki/ui/fields": Fields,
    "@jocki/ui/column-editor": ColumnEditor,
    "@jocki/ui/columns-table": ColumnsTable,
    "@jocki/ui/primitives/command": Command,
    "@jocki/ui/primitives/sheet": Sheet,
    "@jocki/ui/primitives/button": Button,
    "@jocki/ui/loading-spinner": LoadingSpinner,
    "@jocki/ui/primitives/button-group": ButtonGroup,
    "@jocki/ui/primitives/input": Input,
    "@jocki/ui/primitives/dialog": Dialog,
    "@jocki/ui/primitives/select": Select,
    "@jocki/ui/primitives/table": Table,
    "@jocki/ui/primitives/badge": Badge,
    "@jocki/ui/primitives/popover": Popover,
    "@jocki/ui/primitives/alert-dialog": AlertDialog,
    "@jocki/ui/primitives/calendar": CalendarUI,
    "@jocki/ui/primitives/card": Card,
    "@jocki/ui/primitives/collapsible": Collapsible,
    "@jocki/ui/primitives/dropdown-menu": DropdownMenu,
    "@jocki/ui/primitives/input-group": InputGroup,
    "@jocki/ui/primitives/label": Label,
    "@jocki/ui/primitives/scroll-area": ScrollArea,
    "@jocki/ui/primitives/separator": Separator,
    "@jocki/ui/primitives/sonner": Sonner,
    "@jocki/ui/notifications": Notifications,
    "@jocki/ui/optimistic": Optimistic,
    "@jocki/ui/primitives/switch": Switch,
    "@jocki/ui/primitives/tabs": Tabs,
    "@jocki/ui/primitives/toggle": Toggle,
    "@jocki/ui/primitives/combobox": Combobox,
    "@jocki/ui/primitives/breadcrumb": Breadcrumb,
    "@jocki/ui/primitives/checkbox": Checkbox,
    "@jocki/ui/primitives/textarea": Textarea,
    "@jocki/ui/choice-select": ChoiceSelect,
    "@jocki/ui/value-combobox": ValueCombobox,
    "@jocki/ui/query-controls": QueryControls,
    "@jocki/ui/collection-view": CollectionView,
    "@jocki/ui/collection-view-model": CollectionModel,
    "@jocki/ui/calendar-model": CalendarModel,
    "@jocki/ui/calendar-view": CalendarView,
    "@jocki/ui/collection-drag": CollectionDrag,
    "@jocki/ui/edit-actions": EditActions,
    "@jocki/ui/download": Download,
    "@jocki/platform/plugin-sdk/execution": Execution,
    "@jocki/ui/execution-target": {
      ExecutionTarget: (
        props: React.ComponentProps<typeof ExecutionTarget>,
      ) => {
        const record = runtime.node.records.get(props.resourceId);
        invariant(record, "NOT_FOUND", "Execution item is unavailable");
        allowed(record.collection);
        return (
          <ExecutionTarget
            {...props}
            runtime={runtime}
            readOnly={
              props.readOnly ||
              (record.pluginId !== manifest.id &&
                !(
                  manifest.consumes.commands.includes(
                    record.collection + ".put",
                  ) && grants.includes(record.collection + ".put")
                ))
            }
          />
        );
      },
    },
    "@jocki/ui/record-table": {
      RecordTable: (props: React.ComponentProps<typeof RecordTable>) => {
        allowed(props.collection);
        return (
          <RecordTable
            {...props}
            runtime={runtime}
            managedAccess={manifest.id}
            storeOverride={
              props.storeOverride ??
              (workspace.collection(props.collection) as never)
            }
            readOnly={
              props.readOnly ||
              (Catalog.getSchema(props.collection).pluginId !== manifest.id &&
                !manifest.consumes.commands.includes(props.collection + ".put"))
            }
          />
        );
      },
    },
    "@jocki/platform/field-types": FieldTypes,
    "@jocki/platform/core/timers": Timers,
    "@jocki/platform/core/field-references": References,
    "@jocki/platform/core/collection-tables": CollectionTables,
    "@jocki/platform/core/catalog": Catalog,
    "@jocki/platform/core/calendar": Calendar,
    "@jocki/platform/core/calendar-values": CalendarValues,
    "@jocki/platform/core/workflows": Workflows,
  };
}
