import { Companions, companionOwner } from "../packages/core/vaults/companions";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { NodeVaultFiles } from "../packages/platform-node/vault-files";
import { FileVault, fileText } from "../packages/core/vaults/vault";
import {
  CSDBDraft,
  parseCSDB,
  validateCSDBType,
} from "../packages/core/vaults/csdb";
import { contentTypes } from "../packages/core/vaults/content-types";
import { utf8 } from "../packages/core/crypto";
import { sidecarPath, parseResource } from "../packages/core/vaults/metadata";

// A separate vault identity lets both folders coexist. Never copy replica metadata.
const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg)
  throw Error("Usage: copy-task-vault.ts <source-folder> <new-folder>");
const source = await NodeVaultFiles.open(path.resolve(sourceArg));
const visibleFiles = (files: string[]) =>
  files.filter(
    (name) =>
      path.basename(name) !== ".DS_Store" &&
      !name.split("/").some((part) => part.endsWith(".saddle")),
  );
const files = visibleFiles(await source.list());
const snapshot = new Map<string, Uint8Array>();
for (const file of files) {
  const bytes = await source.read(file);
  if (!bytes) throw Error(`Source file disappeared: ${file}`);
  snapshot.set(file, bytes);
}
for (const entry of (await source.scan()).filter(
  (entry) => entry.kind === "companion",
)) {
  const resource = await new Companions(source).read(
    companionOwner(entry.path),
    "resource.json",
  );
  if (resource) snapshot.set(entry.path + "/resource.json", resource);
}
const bytes = snapshot.get("tasks.csdb");
if (!bytes) throw Error("The source folder has no tasks.csdb file.");
const original = new TextDecoder().decode(bytes);
const db = new CSDBDraft(original);
const table = db.document.tables.get("public.tasks");
if (!table) throw Error("Expected public.tasks.");
const fields = structuredClone(
  table.schema.comments["jocki.fields"] ?? {},
) as Record<string, Record<string, unknown>>;
const visibility: Record<string, string> = {};
for (const id of Object.keys(table.schema.columns)) {
  fields[id] ??= {};
  for (const key of [
    "visibility",
    "reference",
    "referenceField",
    "relationship",
  ])
    delete fields[id][key];
  // Retain populated import metadata without forcing it into the working view.
  visibility[id] = [
    "title",
    "status",
    "priority",
    "body",
    "description",
  ].includes(id)
    ? "editable"
    : "hidden";
}
if (fields.parent_id)
  Object.assign(fields.parent_id, {
    label: "Parent",
    control: "reference",
  });
if (fields.sort)
  Object.assign(fields.sort, { label: "Sorting", control: "sorting" });
db.alterTable({
  ...table.schema,
  columns: Object.fromEntries(
    [
      ...new Set([
        "id",
        "uid",
        "dtstamp",
        "title",
        "status",
        "parent_id",
        "priority",
        "body",
        "description",
        "sort",
        ...Object.keys(table.schema.columns),
      ]),
    ]
      .filter((id) => Object.hasOwn(table.schema.columns, id))
      .map((id) => [id, table.schema.columns[id]]),
  ),
  visibility,
  foreign_keys: table.schema.columns.parent_id
    ? [
        ...table.schema.foreign_keys.filter(
          (key) => !key.columns.includes("parent_id"),
        ),
        {
          name: "tasks_parent_fkey",
          columns: ["parent_id"],
          references: { table: table.name, columns: ["id"] },
          label_field: table.schema.columns.title ? "title" : "id",
          relationship: "parent",
        },
      ]
    : table.schema.foreign_keys,
  comments: { ...table.schema.comments, "jocki.fields": fields },
});
const updated = db.toString();
validateCSDBType(
  updated,
  contentTypes.find((type) => type.id === "jocki.task-list"),
);
if (
  !isDeepStrictEqual(
    parseCSDB(original).tables.get(table.name)!.rows,
    parseCSDB(updated).tables.get(table.name)!.rows,
  )
)
  throw Error("Copy preparation changed task data.");
// Detect files saved during snapshot preparation; only read from the source.
if (!isDeepStrictEqual(files, visibleFiles(await source.list())))
  throw Error("Source inventory changed; retry the copy.");
for (const [name, bytes] of snapshot)
  if (!isDeepStrictEqual(bytes, await source.read(name)))
    throw Error(`Source changed: ${name}; retry the copy.`);
const destination = path.resolve(destinationArg);
await mkdir(destination, { mode: 0o700 }); // Must be a new folder.
const fs = await NodeVaultFiles.open(destination);
const release = await fs.acquireWriter();
try {
  const computer = crypto.randomUUID();
  const vault = await FileVault.open(fs, computer, {
    name: path.basename(destination),
  });
  let taskId = "";
  for (const [name, bytes] of snapshot) {
    if (name.split("/").some((part) => part.endsWith(".saddle"))) continue;
    const tasks = name === "tasks.csdb";
    const descriptor = snapshot.get(sidecarPath(name) + "/resource.json");
    let resource = null,
      invalidResource = null;
    if (descriptor) {
      const source = new TextDecoder().decode(descriptor);
      try {
        resource = parseResource(source);
      } catch {
        invalidResource = source;
      }
    }
    const id = await vault.create(
      name,
      tasks ? utf8.encode(updated) : new Uint8Array(bytes),
      tasks
        ? {
            mime: "application/vnd.csdb",
            contentType: "jocki.task-list",
            resource,
            invalidResource,
          }
        : { resource, invalidResource },
    );
    if (tasks) taskId = id;
  }
  const reopened = await FileVault.open(fs, computer);
  const doc = reopened.doc(taskId);
  if (
    reopened.contentType(taskId) !== "jocki.task-list" ||
    !isDeepStrictEqual(
      parseCSDB(fileText(doc)).tables.get(table.name)!.rows,
      table.rows,
    )
  )
    throw Error("Copied vault verification failed.");
  console.log(
    JSON.stringify(
      {
        destination,
        files: snapshot.size,
        rows: table.rows.length,
        contentType: reopened.contentType(taskId),
        independentVault: vault.id,
      },
      null,
      2,
    ),
  );
} finally {
  await release();
}
