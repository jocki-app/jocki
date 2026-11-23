import { extension } from "./mime";
import type { ContentType, FileHandler, FileSummary } from "./contracts";

export function handlersFor(
  file: Pick<FileSummary, "path" | "mime" | "contentType">,
  handlers: FileHandler[],
) {
  const specialized = file.contentType
    ? handlers.filter((h) => h.contentTypes.includes(file.contentType!))
    : [];
  if (specialized.length) return specialized;
  return handlers.filter(
    (h) =>
      !h.requiresContentType &&
      (h.mimeTypes.includes(file.mime) ||
        h.mimeTypes.includes(file.mime.split("/")[0] + "/*") ||
        h.extensions.includes(extension(file.path))),
  );
}
export function validateType(
  file: Pick<FileSummary, "path" | "mime" | "contentType">,
  registry: ContentType[],
) {
  if (!file.contentType) return;
  const type = registry.find((t) => t.id === file.contentType);
  if (!type) throw Error(`Unknown content type: ${file.contentType}`);
  if (!type.mimeTypes.includes(file.mime))
    throw Error(`${type.name} does not support ${file.mime}`);
  if (!type.extensions.includes(extension(file.path)))
    throw Error(`${type.name} does not support this extension`);
}
