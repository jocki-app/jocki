import { z } from "zod";
import { invariant } from "../core/errors";
export const defaultInventoryUrl =
  "https://raw.githubusercontent.com/jocki/jocki-plugin-inventory/main/plugins.json";
export const downloadUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, "Use an HTTP(S) URL without credentials or fragments");
export const inventoryEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/),
    name: z.string().min(1).max(120),
    description: z.string().max(2000),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    publisher: z.string().min(1).max(120),
    license: z.string().min(1).max(120),
    downloadUrl: downloadUrlSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    repositoryUrl: downloadUrlSchema.optional(),
    homepageUrl: downloadUrlSchema.optional(),
    documentationUrl: downloadUrlSchema.optional(),
    tags: z.array(z.string().max(40)).max(20).default([]),
    permissions: z.array(z.string()).max(500),
    dependencies: z.array(z.string()).max(50).default([]),
    grants: z.array(z.string()).max(500),
    platforms: z
      .array(
        z.enum(["browser", "desktop", "ios", "android", "server", "runner"]),
      )
      .default([]),
  })
  .strict();
export const inventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(120),
    publishers: z.record(z.string(), z.string().max(4096)),
    plugins: z.array(inventoryEntrySchema).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.plugins.map((p) => p.id)).size !== value.plugins.length)
      context.addIssue({ code: "custom", message: "Duplicate plugin ID" });
    for (const plugin of value.plugins)
      if (!value.publishers[plugin.publisher])
        context.addIssue({
          code: "custom",
          message: `Missing publisher key for ${plugin.id}`,
        });
  });
export type PluginInventory = z.infer<typeof inventorySchema>;
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;
export function comparePluginVersions(a: string, b: string) {
  const left = a.split(".").map(BigInt),
    right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}
export function inventorySources(input: unknown, allowHttp = false) {
  return [
    ...new Set(
      z
        .array(downloadUrlSchema)
        .max(20)
        .parse(input)
        .map((url) => validateDownloadUrl(url, allowHttp).href),
    ),
  ];
}
/** Merge only compatible publisher identities and immutable releases. */
export function mergeInventories(
  inventories: PluginInventory[],
): PluginInventory {
  const publishers: Record<string, string> = Object.create(null);
  const plugins = new Map<string, InventoryEntry>();
  for (const input of inventories) {
    const inventory = inventorySchema.parse(input);
    for (const [publisher, key] of Object.entries(inventory.publishers)) {
      invariant(
        !publishers[publisher] ||
          publishers[publisher].replace(/\s/g, "") === key.replace(/\s/g, ""),
        "PUBLISHER_CONFLICT",
        `Plugin sources disagree on the key for ${publisher}`,
      );
      publishers[publisher] = key;
    }
    for (const entry of inventory.plugins) {
      const previous = plugins.get(entry.id);
      if (previous) {
        invariant(
          previous.publisher === entry.publisher,
          "PUBLISHER_CONFLICT",
          `Plugin sources disagree on the publisher for ${entry.id}`,
        );
        if (previous.version === entry.version) {
          invariant(
            previous.sha256 === entry.sha256,
            "VERSION_CONFLICT",
            `Plugin sources disagree on ${entry.id}@${entry.version}`,
          );
          continue;
        }
        if (comparePluginVersions(entry.version, previous.version) < 0)
          continue;
      }
      plugins.set(entry.id, entry);
    }
  }
  return inventorySchema.parse({
    schemaVersion: 1,
    name: "Plugin sources",
    publishers,
    plugins: [...plugins.values()],
  });
}
export async function readInventories(
  urls: string[],
  options: Parameters<typeof readInventory>[1] = {},
) {
  return mergeInventories(
    await Promise.all(
      inventorySources(urls, options.allowHttp).map((url) =>
        readInventory(url, options),
      ),
    ),
  );
}
export function validateDownloadUrl(value: string, allowHttp = false) {
  const url = new URL(downloadUrlSchema.parse(value));
  invariant(
    url.protocol === "https:" || (allowHttp && url.protocol === "http:"),
    "TLS_REQUIRED",
    "Plugin downloads require HTTPS; explicitly enable HTTP only for local development",
  );
  return url;
}
export async function boundedDownload(
  value: string,
  limit: number,
  options: {
    allowHttp?: boolean;
    fetch?: typeof fetch;
    followRedirects?: boolean;
  } = {},
) {
  let url = validateDownloadUrl(value, options.allowHttp);
  const signal = AbortSignal.timeout(30000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await (options.fetch ?? fetch)(url, {
      redirect: options.followRedirects ? "follow" : "manual",
      signal,
      credentials: "omit",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      invariant(
        location,
        "DOWNLOAD_FAILED",
        "Download redirect has no location",
      );
      url = validateDownloadUrl(new URL(location, url).href, options.allowHttp);
      continue;
    }
    if (response.url) validateDownloadUrl(response.url, options.allowHttp);
    invariant(
      response.ok && response.body,
      "DOWNLOAD_FAILED",
      `Download returned HTTP ${response.status}`,
    );
    if (Number(response.headers.get("content-length") ?? 0) > limit) {
      await response.body.cancel();
      throw new Error("Download exceeds size limit");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        invariant(
          size <= limit,
          "PAYLOAD_TOO_LARGE",
          "Download exceeds size limit",
        );
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  throw new Error("Too many download redirects");
}
export async function readInventory(
  url: string,
  options: {
    allowHttp?: boolean;
    fetch?: typeof fetch;
    followRedirects?: boolean;
  } = {},
) {
  return inventorySchema.parse(
    JSON.parse(
      new TextDecoder().decode(
        await boundedDownload(url, 2 * 1024 * 1024, options),
      ),
    ),
  );
}
