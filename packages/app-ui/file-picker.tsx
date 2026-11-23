import { useMemo, useRef, useState } from "react";
import { ChevronLeft, File, Folder, Upload } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { ChoiceSelect } from "../ui/choice-select";
import { useReportedError } from "./errors";
export interface PickerEntry {
  id: string;
  path: string;
  kind: "file" | "folder";
  read?(): Promise<Uint8Array>;
  children?: PickerEntry[];
}
export interface PickerRoot {
  id: string;
  name: string;
  entries: PickerEntry[];
}
export interface PickedFile extends PickerEntry {
  root?: string;
}
export interface FilePickerOptions {
  kind?: "file" | "folder" | "any";
  extensions?: string[];
  multiple?: boolean;
  device?: boolean;
  title?: string;
}
export function pickerAccepts(
  entry: Pick<PickerEntry, "kind" | "path">,
  options: FilePickerOptions,
) {
  return (
    (options.kind === "any" || entry.kind === (options.kind ?? "file")) &&
    (entry.kind === "folder" ||
      !options.extensions?.length ||
      options.extensions.some((extension) =>
        entry.path
          .toLowerCase()
          .endsWith(
            extension.startsWith(".")
              ? extension.toLowerCase()
              : "." + extension.toLowerCase(),
          ),
      ))
  );
}
/** A capability-fed picker for workspace or device files. No CSDB assumptions. */
export function FilePicker({
  roots,
  options = {},
  onChoose,
  onCancel,
}: {
  roots: PickerRoot[];
  options?: FilePickerOptions;
  onChoose(entries: PickedFile[]): Promise<unknown> | unknown;
  onCancel(): void;
}) {
  const [rootId, setRoot] = useState(roots[0]?.id ?? ""),
    [path, setPath] = useState(""),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<PickedFile[]>([]),
    [busy, setBusy] = useState(false);
  const [, report] = useReportedError("file-picker"),
    input = useRef<HTMLInputElement>(null),
    directoryInput = useRef<HTMLInputElement>(null);
  const root = roots.find((root) => root.id === rootId),
    prefix = path ? path + "/" : "";
  const entries = useMemo(() => {
    const all = root?.entries ?? [],
      byPath = new Map<string, PickerEntry>(),
      folders = new Map(
        all
          .filter((entry) => entry.kind === "folder")
          .map((entry) => [entry.path, entry]),
      );
    for (const entry of all) {
      if (search) {
        if (
          entry.path.toLowerCase().includes(search.toLowerCase()) &&
          pickerAccepts(entry, options)
        )
          byPath.set(entry.path, entry);
        continue;
      }
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length),
        slash = rest.indexOf("/");
      if (slash >= 0) {
        const folder = prefix + rest.slice(0, slash);
        byPath.set(
          folder,
          folders.get(folder) ?? { id: folder, path: folder, kind: "folder" },
        );
      } else if (
        entry.path !== path &&
        (entry.kind === "folder" || pickerAccepts(entry, options))
      )
        byPath.set(entry.path, entry);
    }
    return [...byPath.values()].sort(
      (a, b) =>
        Number(b.kind === "folder") - Number(a.kind === "folder") ||
        a.path.localeCompare(b.path),
    );
  }, [root, prefix, search, options.kind, JSON.stringify(options.extensions)]);
  const choose = async (items: PickedFile[]) => {
    if (items.some((item) => !pickerAccepts(item, options))) {
      report(Error("Choose a supported file or folder"));
      return;
    }
    setBusy(true);
    try {
      await onChoose(items);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (entry: PickerEntry) => {
    const item = { ...entry, root: rootId };
    setSelected((previous) =>
      previous.some((p) => p.id === item.id && p.root === item.root)
        ? previous.filter((p) => p.id !== item.id || p.root !== item.root)
        : options.multiple
          ? [...previous, item]
          : [item],
    );
  };
  const chooseFolderFiles = (files: File[]) => {
    if (!files.length) return;
    const names = [
      ...new Set(files.map((file) => file.webkitRelativePath.split("/")[0])),
    ];
    void choose(
      names.map((name) => ({
        id: name,
        path: name,
        kind: "folder",
        children: files
          .filter((file) => file.webkitRelativePath.startsWith(name + "/"))
          .map((file) => ({
            id: file.webkitRelativePath,
            path: file.webkitRelativePath.slice(name.length + 1),
            kind: "file",
            read: async () => new Uint8Array(await file.arrayBuffer()),
          })),
      })),
    );
  };
  return (
    <section className="flex min-h-0 flex-col gap-3" data-file-picker>
      {options.title && <h2 className="font-medium">{options.title}</h2>}
      <div className="flex gap-2">
        {!!roots.length && (
          <ChoiceSelect
            aria-label="File location"
            value={rootId}
            options={roots.map((root) => ({
              value: root.id,
              label: root.name,
            }))}
            onValueChange={(value) => {
              setRoot(value);
              setPath("");
            }}
          />
        )}
        {options.device !== false && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Upload />
            Device
          </Button>
        )}
        {options.device !== false &&
          options.kind === "any" &&
          typeof document !== "undefined" &&
          "webkitdirectory" in document.createElement("input") && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => directoryInput.current?.click()}
            >
              <Folder />
              Device folder
            </Button>
          )}
        <input
          ref={directoryInput}
          type="file"
          className="hidden"
          aria-label="Choose device folder"
          {...{ webkitdirectory: "" }}
          onChange={(event) => {
            chooseFolderFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <input
          ref={input}
          className="hidden"
          aria-label="Choose device files"
          type="file"
          accept={options.extensions
            ?.map((e) => (e.startsWith(".") ? e : "." + e))
            .join(",")}
          multiple={options.multiple}
          {...(options.kind === "folder" ? { webkitdirectory: "" } : {})}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (options.kind === "folder") {
              chooseFolderFiles(files);
            } else {
              const items = files.map((file) => ({
                id: file.name,
                path: file.name,
                kind: "file" as const,
                read: async () => new Uint8Array(await file.arrayBuffer()),
              }));
              if (items.some((item) => !pickerAccepts(item, options)))
                report(Error("Choose a supported file type"));
              else void choose(items);
            }
            event.target.value = "";
          }}
        />
      </div>
      <Input
        aria-label="Search files"
        placeholder="Search files and folders"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="flex items-center gap-2 text-sm">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Parent folder"
          disabled={!path || busy}
          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
        >
          <ChevronLeft />
        </Button>
        <span className="truncate">
          {root?.name}
          {path && " / " + path}
        </span>
        {root && (options.kind ?? "file") !== "file" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              toggle(
                root?.entries.find(
                  (entry) => entry.kind === "folder" && entry.path === path,
                ) ?? { id: path || rootId, path, kind: "folder" },
              )
            }
          >
            Select folder
          </Button>
        )}
      </div>
      <div
        className="max-h-[50dvh] min-h-40 overflow-auto rounded-md border"
        role="listbox"
        aria-label="Files"
        aria-multiselectable={options.multiple}
      >
        {entries.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            No matching files.
          </p>
        )}
        {entries.map((entry) => (
          <div key={entry.path} className="flex items-center">
            <button
              type="button"
              role="option"
              aria-selected={selected.some(
                (item) => item.root === rootId && item.id === entry.id,
              )}
              disabled={busy}
              className="flex min-w-0 flex-1 items-center gap-2 p-2 text-left text-sm hover:bg-accent aria-selected:bg-accent"
              onClick={() =>
                entry.kind === "folder"
                  ? (setPath(entry.path), setSearch(""))
                  : toggle(entry)
              }
              onDoubleClick={() =>
                entry.kind === "file" &&
                void choose([{ ...entry, root: rootId }])
              }
            >
              {entry.kind === "folder" ? (
                <Folder className="size-4 shrink-0" />
              ) : (
                <File className="size-4 shrink-0" />
              )}
              <span className="truncate">
                {search ? entry.path : entry.path.split("/").pop()}
              </span>
            </button>
            {entry.kind === "folder" && (options.kind ?? "file") !== "file" && (
              <Button size="sm" variant="ghost" onClick={() => toggle(entry)}>
                Select
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={busy || !selected.length}
          onClick={() => void choose(selected)}
        >
          {busy ? "Opening…" : "Choose"}
          {options.multiple && selected.length ? ` (${selected.length})` : ""}
        </Button>
      </div>
    </section>
  );
}
