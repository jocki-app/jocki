import * as automerge from "@automerge/automerge";
import * as slim from "@automerge/automerge/slim";

export function automergeState() {
  return {
    initialized: automerge.isWasmInitialized(),
    slimInitialized: slim.isWasmInitialized(),
    sharedModule: automerge.from === slim.from,
  };
}
