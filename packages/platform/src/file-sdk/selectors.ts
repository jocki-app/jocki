import picomatch from "picomatch/posix";
import type { DocumentSelector, ExtensionDocument } from "./index";
const patterns = new Map<string, (path: string) => boolean>();
export function matchesDocument(
  selector: DocumentSelector,
  doc: Pick<ExtensionDocument, "path" | "mime" | "contentType">,
) {
  if (selector.contentType && selector.contentType !== doc.contentType)
    return false;
  if (
    selector.mime &&
    selector.mime !== doc.mime &&
    selector.mime !== doc.mime.split("/")[0] + "/*"
  )
    return false;
  if (selector.pattern) {
    let match = patterns.get(selector.pattern);
    if (!match) {
      match = picomatch(selector.pattern, { dot: true, posix: true });
      patterns.set(selector.pattern, match);
    }
    if (!match(doc.path)) return false;
  }
  return true;
}
