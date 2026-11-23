# Local timers and workspace home

`core.timers` is an optional presentation and alarm service supplied by UI hosts. Declare it in `sharedServices` and import `TimerService` from `@jocki/platform/plugin-sdk/timers`. It is scoped to the requesting plugin. A headless host may omit the service.

Only submit timers from explicit local user actions, after the associated record write is durable. Receiving or projecting a replicated record must never submit a timer. Submissions and dismissals are persisted in device-local workspace metadata before acknowledgement or presentation. They are not replicated scheduling instructions. A plugin can subscribe to completion updates and handle its own locally submitted timers; it must not execute arbitrary commands found in replicated data.

```ts
const timers = context.services.require<TimerService>("core.timers");
// In an explicit Start handler, while a user gesture is active:
await timers.requestPermission(true);
// Save the associated record through core storage, then:
await timers.submit({
  id: saved.id,
  title: "Focus",
  startedAt: Date.now(),
  durationMs: 25 * 60_000,
  priority: 100,
  alert: { tone: "chime", repeat: "indefinite" },
});
```

Omit `durationMs` for elapsed tracking. `pausedAt` is an epoch timestamp and `pausedMs` is accumulated paused time; resubmit the same ID to pause or resume. `list()` and `subscribe()` expose this plugin's submissions, including durable `completedAt` values. `remove()` cancels presentation and scheduling; `dismiss()` stops a completion alert. Both affect only the requesting plugin. The host presents all available timers, with larger priorities winning a constrained native slot. Track uses 10 and Time uses 100. Up to 32 local timers may be submitted at once.

The shared timer UI remains visible across pages. Desktop hosts update the tray tooltip/menu, and macOS also displays the primary clock beside the menu-bar icon. Closing the desktop window keeps timers active; quitting the process stops desktop delivery until it is reopened. Browser audio requires a user gesture and an active browser process. Once tones play once; Indefinite tones repeat until dismissed.

iOS supplies ActivityKit Live Activities through the bundled widget extension (iOS 16.4+), with relevance ordered by plugin priority. Persistent system alarms use AlarmKit on iOS 26+ and require alarm permission. Once alerts use local notifications and bundled sounds. When the system permits more than one Live Activity, both timers can appear; otherwise the highest-priority timer wins. Actual Lock Screen, Dynamic Island, Watch/Mac mirroring and alarm delivery depend on device capabilities and OS permissions. Android supplies chronometer notifications, scheduled alarms, and a Stop alert action. Exact alarm delivery requires the OS's exact-alarm permission; otherwise Android's allowed inexact alarm scheduling applies. Notification permissions and system channel settings still govern sound delivery. Native dismissal is reconciled with local state when the app resumes.

## Workspace home

A plugin can register an eligible home destination through `core.ui`:

```ts
const dispose = ui.registerHome({ id: "overview", title: "Overview", page: "overview" });
```

The page must be declared in the plugin manifest; omitting `page` uses its main page. The first enabled provider automatically becomes the workspace breadcrumb destination if no preference exists. The built-in adapter registers the Dashboard plugin's main page. Settings → Workspace → Workspace home lists registered providers and always includes Plugins. An explicit choice is retained when providers are enabled or disabled; an unavailable choice temporarily falls back to Plugins. Registration is UI lifecycle state, while the user's choice is stored locally and durably. Release the returned handle during plugin cleanup.
