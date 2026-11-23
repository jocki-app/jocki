import { z } from "zod";
import { boundedDownload, downloadUrlSchema } from "../plugin-sdk/inventory";
export const fileExtensionInventorySchema = z
  .object({
    format: z.literal("jocki-extension-inventory/1"),
    name: z.string().min(1),
    publishers: z.record(z.string(), z.string()),
    extensions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9.-]*$/),
            name: z.string(),
            description: z.string(),
            version: z.string().regex(/^\d+\.\d+\.\d+$/),
            publisher: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            downloadUrl: downloadUrlSchema,
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.extensions.map((e) => e.id)).size !==
      value.extensions.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate extension IDs" });
    for (const e of value.extensions)
      if (!value.publishers[e.publisher])
        ctx.addIssue({
          code: "custom",
          message: "Missing publisher public key",
        });
  });
export type FileExtensionInventory = z.infer<
  typeof fileExtensionInventorySchema
>;
export async function readFileExtensionInventory(url: string) {
  return fileExtensionInventorySchema.parse(
    JSON.parse(
      new TextDecoder().decode(
        await boundedDownload(url, 2 * 1024 * 1024, { followRedirects: true }),
      ),
    ),
  );
}
