import "../../packages/platform-node/duckdb";
import fixtures from "./contracts.json";
import { registerExtension } from "@jocki/platform/core/catalog";
for (const fixture of fixtures)
  registerExtension(fixture.manifest, fixture.schemas);
