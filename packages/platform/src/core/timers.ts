import type {
  SubmittedTimer,
  TimerSubmission,
  TimerService,
} from "../plugin-sdk/timers";
import { invariant } from "./errors";
export function timerElapsed(timer: TimerSubmission, now = Date.now()) {
  return Math.max(
    0,
    (timer.pausedAt ?? now) - timer.startedAt - (timer.pausedMs ?? 0),
  );
}
export function timerSeconds(timer: TimerSubmission, now = Date.now()) {
  const elapsed = timerElapsed(timer, now);
  return Math.max(
    0,
    timer.durationMs === undefined
      ? Math.floor(elapsed / 1000)
      : Math.ceil((timer.durationMs - elapsed) / 1000),
  );
}
export function primaryTimer(timers: SubmittedTimer[]) {
  return [...timers].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.startedAt - b.startedAt ||
      a.id.localeCompare(b.id),
  )[0];
}
export function validateTimer(timer: TimerSubmission) {
  invariant(
    timer &&
      typeof timer.id === "string" &&
      timer.id.length > 0 &&
      timer.id.length <= 200 &&
      typeof timer.title === "string" &&
      timer.title.length <= 200 &&
      Number.isFinite(timer.startedAt) &&
      timer.startedAt >= 0,
    "INVALID_TIMER",
    "A timer needs an ID, title and valid start time",
  );
  invariant(
    timer.durationMs === undefined ||
      (Number.isFinite(timer.durationMs) &&
        timer.durationMs > 0 &&
        timer.durationMs <= 365 * 86400000),
    "INVALID_TIMER",
    "Invalid timer duration",
  );
  invariant(
    (timer.pausedAt === undefined ||
      (Number.isFinite(timer.pausedAt) && timer.pausedAt >= timer.startedAt)) &&
      (timer.pausedMs === undefined ||
        (Number.isFinite(timer.pausedMs) && timer.pausedMs >= 0)),
    "INVALID_TIMER",
    "Invalid pause state",
  );
  invariant(
    timer.priority === undefined ||
      (Number.isSafeInteger(timer.priority) &&
        Math.abs(timer.priority) <= 1000000),
    "INVALID_TIMER",
    "Invalid timer priority",
  );
  invariant(
    !timer.alert ||
      (["none", "chime", "bell", "gentle"].includes(timer.alert.tone) &&
        ["once", "indefinite"].includes(timer.alert.repeat) &&
        (timer.alert.vibration === undefined ||
          ["none", "short", "pulse"].includes(timer.alert.vibration))),
    "INVALID_TIMER",
    "Invalid timer alert",
  );
}
/** Storage and presentation are explicit capabilities; this module has no platform imports. */
export class TimerCoordinator {
  private timers = new Map<string, SubmittedTimer>();
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private ready?: Promise<void>;
  constructor(
    private storage: {
      load(): Promise<SubmittedTimer[]>;
      save(timers: SubmittedTimer[]): Promise<void>;
    },
  ) {}
  initialize() {
    return (this.ready ??= this.storage.load().then((timers) => {
      for (const timer of Array.isArray(timers) ? timers.slice(0, 32) : []) {
        try {
          validateTimer(timer);
          if (
            typeof timer.pluginId === "string" &&
            /^[a-z][a-z0-9.-]*$/.test(timer.pluginId) &&
            (timer.completedAt === undefined ||
              (Number.isFinite(timer.completedAt) &&
                timer.completedAt >= timer.startedAt))
          )
            this.timers.set(
              timer.pluginId + ":" + timer.id,
              structuredClone(timer),
            );
        } catch {
          /* Invalid local state is never scheduled. */
        }
      }
      this.notify();
    }));
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Subscriber failures cannot roll back a durable timer or block other observers.
        this.listeners.delete(listener);
      }
    }
  }
  list = () => [...this.timers.values()].map((timer) => structuredClone(timer));
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change(work: (next: Map<string, SubmittedTimer>) => void) {
    const run = this.queue.then(async () => {
      await this.initialize();
      const next = new Map(this.timers);
      work(next);
      await this.storage.save([...next.values()]);
      this.timers = next;
      this.notify();
    });
    this.queue = run.catch(() => {});
    return run;
  }
  forPlugin(pluginId: string): TimerService {
    return {
      requestPermission: async () => true,
      submit: async (input) => {
        validateTimer(input);
        const timer = structuredClone(input);
        await this.change((next) => {
          invariant(
            next.has(pluginId + ":" + timer.id) || next.size < 32,
            "TIMER_LIMIT",
            "At most 32 local timers can run at once",
          );
          next.set(pluginId + ":" + timer.id, {
            id: timer.id,
            title: timer.title,
            startedAt: timer.startedAt,
            durationMs: timer.durationMs,
            pausedAt: timer.pausedAt,
            pausedMs: timer.pausedMs,
            priority: timer.priority,
            alert: timer.alert,
            pluginId,
          });
        });
      },
      remove: (id) =>
        this.change((next) => {
          next.delete(pluginId + ":" + id);
        }),
      dismiss: (id) =>
        this.change((next) => {
          next.delete(pluginId + ":" + id);
        }),
      list: () => this.list().filter((t) => t.pluginId === pluginId),
      subscribe: this.subscribe,
    };
  }
  async tick(now = Date.now()) {
    await this.initialize();
    if (
      !this.list().some(
        (t) =>
          !t.completedAt &&
          !t.pausedAt &&
          t.durationMs !== undefined &&
          timerElapsed(t, now) >= t.durationMs,
      )
    )
      return;
    await this.change((next) => {
      for (const [id, t] of next)
        if (
          !t.completedAt &&
          !t.pausedAt &&
          t.durationMs !== undefined &&
          timerElapsed(t, now) >= t.durationMs
        )
          next.set(id, {
            ...t,
            completedAt: t.startedAt + (t.pausedMs ?? 0) + t.durationMs,
          });
    });
  }
  removePlugin(pluginId: string) {
    return this.change((next) => {
      for (const [id, t] of next) if (t.pluginId === pluginId) next.delete(id);
    });
  }
}
