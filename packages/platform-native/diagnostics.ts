import { Capacitor, registerPlugin } from "@capacitor/core";
export interface NativeRuntimeEvent {
  type: "memory-warning" | "web-content-terminated";
  at: string;
}
const diagnostics = registerPlugin<{
  consume(): Promise<{ events: NativeRuntimeEvent[] }>;
}>("RuntimeDiagnostics");
export async function consumeNativeRuntimeEvents(): Promise<
  NativeRuntimeEvent[]
> {
  if (
    !Capacitor.isNativePlatform() ||
    !Capacitor.isPluginAvailable("RuntimeDiagnostics")
  )
    return [];
  const { events } = await diagnostics.consume();
  return events
    .slice(-8)
    .filter(
      (event) =>
        ["memory-warning", "web-content-terminated"].includes(event.type) &&
        Number.isFinite(Date.parse(event.at)),
    );
}
