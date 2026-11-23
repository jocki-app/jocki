import { expect, it } from "vitest";
import { field, type RecordSchema } from "@jocki/platform/field-types";
import {
  pluginFeatureFields,
  withCollectionTables,
} from "@jocki/platform/core/collection-tables";
it("offers timer behavior and excludes passive Track metadata", () => {
  const schema = withCollectionTables({
    id: "track",
    pluginId: "track",
    name: "Track",
    version: 1,
    fields: [
      field("title", "Activity"),
      field("started_at", "Start", "timestamp with time zone"),
      field("ended_at", "End", "timestamp with time zone"),
      field("notes", "Notes"),
      field("measurement", "Measurement", "numeric"),
      field("unit", "Unit"),
    ],
  });
  expect(pluginFeatureFields(schema).map((f) => f.id)).toEqual([
    "title",
    "started_at",
    "ended_at",
  ]);
});
it("requires explicit behavioral features for additional plugins and excludes required fields", () => {
  const schema: RecordSchema = {
    id: "example",
    pluginId: "example",
    name: "Example",
    version: 1,
    fields: [
      field("label", "Label"),
      field("enabled", "Enabled", "boolean"),
      field("id", "ID", "uuid", { required: true }),
    ],
  };
  expect(pluginFeatureFields(schema)).toEqual([]);
  expect(
    pluginFeatureFields({ ...schema, featureFields: ["enabled", "id"] }).map(
      (f) => f.id,
    ),
  ).toEqual(["enabled"]);
});
