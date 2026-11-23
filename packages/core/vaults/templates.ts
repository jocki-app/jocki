import * as A from "@automerge/automerge";
import type { Draft } from "./vault";
import type { TemplateReference } from "./contracts";

export function mergeTemplate(
  previous: string,
  local: string,
  updated: string,
) {
  const base = A.from({ text: previous });
  const mine = A.change(A.clone(base), (d) => A.updateText(d, ["text"], local));
  const theirs = A.change(A.clone(base), (d) =>
    A.updateText(d, ["text"], updated),
  );
  return A.merge(mine, theirs).text;
}
/** Called once by open-file, never subscribed to a timer or source change event. */
export async function checkTemplateOnOpen(
  draft: Draft,
  readSource: (reference: TemplateReference) => Promise<string | undefined>,
) {
  if (!draft.template) return false;
  const source = await readSource(draft.template);
  if (source === undefined || source === draft.template.baseline) return false;
  draft.text = mergeTemplate(draft.template.baseline, draft.text, source);
  draft.template = { ...draft.template, baseline: source };
  return true;
}
export function applyTemplate(
  draft: Draft,
  source: { file: string; hint: string; text: string },
  mode: "copy" | "reference",
) {
  draft.text = source.text;
  draft.template =
    mode === "reference"
      ? { file: source.file, hint: source.hint, baseline: source.text }
      : null;
}
