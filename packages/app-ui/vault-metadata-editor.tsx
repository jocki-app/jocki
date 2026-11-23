import { useReportedError } from "./errors";
import { useEffect, useState } from "react";
import type { Draft } from "../core/vaults/vault";
import {
  newResource,
  parseResource,
  serializeResource,
} from "../core/vaults/metadata";
import { Textarea } from "../ui/primitives/textarea";
export function VaultMetadataEditor({
  draft,
  path,
  changed,
}: {
  draft: Draft;
  path: string;
  changed(): void;
}) {
  const source =
    draft.invalidResource ??
    (draft.resource ? serializeResource(draft.resource) : "");
  const [value, setValue] = useState(source),
    [, setError] = useReportedError("vault-metadata-editor");
  useEffect(() => setValue(source), [source]);
  return (
    <section className="space-y-2">
      <h3 className="font-medium">File metadata</h3>
      <p className="text-xs text-muted-foreground">
        Optional Frictionless Data Resource sidecar: {path.split("/").pop()}
        .saddle. Add custom properties in the metadata object.
      </p>
      <Textarea
        aria-label="Resource metadata"
        className="min-h-52 font-mono text-xs"
        placeholder={serializeResource({ ...newResource(path), metadata: {} })}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          try {
            draft.resource = value.trim() ? parseResource(value) : null;
            draft.invalidResource = null;
            setError("");
          } catch (error) {
            draft.resource = null;
            draft.invalidResource = value;
            setError(String(error));
          }
          changed();
        }}
      />
    </section>
  );
}
