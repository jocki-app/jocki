import { z } from "zod";
import { Repository } from "./repository";
import { PluginRegistry } from "@jocki/platform/core/registry";
import { MessageRouter } from "@jocki/platform/core/messages";
import {
  catalog,
  getSchema,
  schemaById,
} from "@jocki/platform/core/catalog";
import { invariant } from "@jocki/platform/core/errors";
import type { Principal, Mutation } from "@jocki/platform/plugin-sdk";
import type { Query } from "@jocki/platform/field-types";

const uuid = z.string().uuid();
const mutationSchema = z
  .object({
    id: uuid,
    resourceId: uuid,
    pluginId: z.string(),
    collection: z.string(),
    operation: z.enum(["put", "delete"]),
    baseRevision: z.number().int().nonnegative(),
    data: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();
export function registryFor(
  repo: Repository,
  principal: Principal,
  options: { deviceLocal?: boolean } = {},
) {
  return new PluginRegistry({
    load: async () => {
      const { rows } = await repo.db.query<{
        id: string;
        version: string;
        installed: boolean;
        enabled: boolean;
        features: string[];
      }>(
        "SELECT id,version,installed,enabled,features FROM jocki.plugins WHERE workspace_id=$1",
        [principal.workspaceId],
      );
      return rows;
    },
    save: async (state) => {
      // Device-authorized reconciliation updates only this device's installation cache.
      if (!options.deviceLocal)
        invariant(
          (await repo.membership(principal, true)) === "write",
          "PERMISSION_DENIED",
          "Write access is required to manage plugins",
        );
      await repo.db.query(
        "INSERT INTO jocki.plugins(workspace_id,id,version,installed,enabled,features) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,id) DO UPDATE SET version=EXCLUDED.version,installed=EXCLUDED.installed,enabled=EXCLUDED.enabled,features=EXCLUDED.features",
        [
          principal.workspaceId,
          state.id,
          state.version,
          state.installed,
          state.enabled,
          JSON.stringify(state.features),
        ],
      );
    },
  });
}
export async function routerFor(repo: Repository, principal: Principal) {
  const router = new MessageRouter();
  for (const manifest of catalog)
    for (const command of manifest.provides.commands) {
      const [collection, action] = command.split(".");
      if (
        !schemaById.has(collection) ||
        !["list", "put", "delete"].includes(action)
      )
        continue;
      const schema = getSchema(collection);
      const inputSchema =
        action === "list"
          ? z.object({ query: z.unknown().optional() })
          : mutationSchema;
      router.register(command, {
        permission: `${manifest.id}.${action === "list" ? "read" : "write"}`,
        validate: (input) => inputSchema.parse(input),
        execute: async (input, context) => {
          const principal = context.principal;
          await repo.requirePlugin(principal, manifest.id);
          if (action === "list")
            return repo.list(
              principal,
              collection,
              (input as { query?: Query }).query,
            );
          const mutation = input as Mutation;
          invariant(
            mutation.collection === schema.id &&
              mutation.pluginId === manifest.id,
            "UNDECLARED_COLLECTION",
            "Wrong resource contract",
          );
          invariant(
            (action === "delete") === (mutation.operation === "delete"),
            "VALIDATION_FAILED",
            "Command and mutation operation disagree",
          );
          return repo.mutate(principal, mutation, "plugin");
        },
      });
    }
  return router;
}
