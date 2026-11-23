import { finishLocalTimeTimers } from "./timer-completion";
import { useEffect, useState } from "react";
import { Clock3, BellRing } from "lucide-react";
import { primaryTimer, timerSeconds } from "@jocki/platform/core/timers";
import type { SubmittedTimer } from "@jocki/platform/plugin-sdk/timers";
import { presentTimers, pollTimerDismissals } from "../platform-browser/timers";
import { Button } from "../ui/primitives/button";
import { notify } from "../ui/notifications";
import type { AppRuntime } from "./runtime";
export function WorkspaceTimers({ runtime }: { runtime: AppRuntime }) {
  const [timers, setTimers] = useState<SubmittedTimer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (alive) setTimers(runtime.timers.list());
    };
    const unsubscribe = runtime.timers.subscribe(refresh);
    setLoaded(false);
    void runtime.timers
      .initialize()
      .then(() => {
        refresh();
        if (alive) setLoaded(true);
      })
      .catch(notify.error);
    let ticking = false;
    const tick = async () => {
      setNow(Date.now());
      if (ticking) return;
      ticking = true;
      try {
        await runtime.timers.tick();
        await finishLocalTimeTimers(runtime);
        await pollTimerDismissals((pluginId, id) => {
          void runtime.timers
            .forPlugin(pluginId)
            .dismiss(id)
            .catch(notify.error);
        });
      } catch (error) {
        if (alive) notify.error(error);
      } finally {
        ticking = false;
      }
    };
    const interval = setInterval(() => {
      void tick();
    }, 1000);
    const resume = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", resume);
    const dismiss = window.jockiNative?.timers?.subscribe((t) => {
      void runtime.timers
        .forPlugin(t.pluginId)
        .dismiss(t.id)
        .catch(notify.error);
    });
    return () => {
      alive = false;
      unsubscribe();
      dismiss?.();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", resume);
      void presentTimers({ timers: [] }, () => {}).catch(notify.error);
    };
  }, [runtime]);
  const visible = timers
    .filter((t) => runtime.registry.enabled(t.pluginId))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  useEffect(() => {
    if (!loaded) return;
    void presentTimers(
      { timers: visible, primary: primaryTimer(visible) },
      (pluginId, id) => {
        void runtime.timers.forPlugin(pluginId).dismiss(id).catch(notify.error);
      },
    ).catch(notify.error);
  }, [runtime, timers, loaded, visible.map((t) => t.pluginId).join(",")]);
  if (!visible.length) return null;
  return (
    <section
      aria-label="Workspace timers"
      className="mb-4 flex flex-wrap gap-2"
    >
      {visible.map((t) => {
        const seconds = timerSeconds(t, now),
          duration = [
            Math.floor(seconds / 3600),
            Math.floor(seconds / 60) % 60,
            seconds % 60,
          ]
            .map((n) => String(n).padStart(2, "0"))
            .join(":");
        return (
          <div
            key={t.pluginId + ":" + t.id}
            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm"
          >
            {t.completedAt ? (
              <BellRing className="size-4" />
            ) : (
              <Clock3 className="size-4" />
            )}
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => void runtime.navigate(t.pluginId)}
            >
              {t.title || t.pluginId}
            </Button>
            <span className="font-mono tabular-nums">
              {t.completedAt ? "Finished" : duration}
            </span>
            {t.pausedAt && !t.completedAt ? <span>Paused</span> : null}
            {t.completedAt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void runtime.timers
                    .forPlugin(t.pluginId)
                    .dismiss(t.id)
                    .catch(notify.error)
                }
              >
                {t.alert?.repeat === "indefinite" ? "Stop alert" : "Dismiss"}
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}
