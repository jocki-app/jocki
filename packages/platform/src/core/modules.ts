import * as timers from "./timers";
import * as references from "./field-references";
import * as collectionTables from "./collection-tables";
import * as execution from "../plugin-sdk/execution";
import * as fields from "../field-types";
import * as errors from "./errors";
import * as workflows from "./workflows";
import * as calendar from "./calendar-values";
/** Shared runtime imports for portable plugin bundles. Native/UI APIs require separate services. */
export const coreModules: Record<string, unknown> = {
  "@jocki/platform/core/timers": timers,
  "@jocki/platform/core/field-references": references,
  "@jocki/platform/core/collection-tables": collectionTables,
  "@jocki/platform/plugin-sdk/execution": execution,
  "@jocki/platform/field-types": fields,
  "@jocki/platform/core/errors": errors,
  "@jocki/platform/core/workflows": workflows,
  "@jocki/platform/core/calendar-values": calendar,
};
