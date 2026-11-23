import { Capacitor, registerPlugin } from "@capacitor/core";
import type {
  SubmittedTimer,
  TimerPresentation,
} from "@jocki/platform/plugin-sdk/timers";
const mobile = registerPlugin<{
  present(
    options: TimerPresentation,
  ): Promise<{ dismissed?: Array<{ pluginId: string; id: string }> }>;
  requestPermission(options: {
    alarms: boolean;
  }): Promise<{ granted: boolean; persistent?: boolean }>;
  dismissed(): Promise<{ dismissed: Array<{ pluginId: string; id: string }> }>;
}>("Timers");
let audio: AudioContext | undefined;
const played = new Set<string>();
const sounding = new Map<string, Set<OscillatorNode>>();
let current: SubmittedTimer[] = [];
let nativeKey = "";
let nativeQueue: Promise<unknown> = Promise.resolve();
function serializeNative(work: () => Promise<void>) {
  const run = nativeQueue.then(work);
  nativeQueue = run.catch(() => {});
  return run;
}
let repeating: ReturnType<typeof setInterval> | undefined;
export async function prepareTimers(alarms = false) {
  if (window.jockiNative?.timers)
    return window.jockiNative.timers.requestPermission();
  if (Capacitor.isNativePlatform()) {
    const result = await mobile.requestPermission({ alarms });
    if (alarms && result.persistent === false)
      throw Error(
        "Persistent iOS alarms require iOS 26 and alarm permission. Choose a Once tone or enable alarm permission.",
      );
    return result.granted;
  }
  if (typeof AudioContext !== "undefined") {
    audio ??= new AudioContext();
    await audio.resume();
  }
  return true;
}
function tone(timer: SubmittedTimer) {
  if (!audio || !timer.alert || timer.alert.tone === "none") return;
  const oscillator = audio.createOscillator(),
    gain = audio.createGain();
  oscillator.frequency.value =
    timer.alert?.tone === "bell"
      ? 880
      : timer.alert?.tone === "gentle"
        ? 440
        : 660;
  gain.gain.setValueAtTime(0.15, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 1);
  const key = timer.pluginId + ":" + timer.id;
  const group = sounding.get(key) ?? new Set<OscillatorNode>();
  group.add(oscillator);
  sounding.set(key, group);
  oscillator.onended = () => {
    group.delete(oscillator);
    if (!group.size) sounding.delete(key);
  };
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 1);
}
export async function presentTimers(
  value: TimerPresentation,
  dismiss: (pluginId: string, id: string) => void,
) {
  if (window.jockiNative?.timers || Capacitor.isNativePlatform())
    return serializeNative(async () => {
      const key = JSON.stringify(value);
      if (nativeKey === key) return;
      if (window.jockiNative?.timers)
        await window.jockiNative.timers.present(value);
      else {
        const result = await mobile.present(value);
        for (const timer of result?.dismissed ?? [])
          dismiss(timer.pluginId, timer.id);
      }
      nativeKey = key;
    });
  if (value.timers.every((t) => !t.completedAt)) navigator.vibrate?.(0);
  current = value.timers.filter(
    (t) =>
      t.completedAt &&
      t.alert &&
      (t.alert.tone !== "none" ||
        (t.alert?.vibration && t.alert.vibration !== "none")),
  );
  const allowed = new Set(current.map((t) => t.pluginId + ":" + t.id));
  for (const [id, group] of sounding)
    if (!allowed.has(id)) {
      for (const oscillator of group) {
        try {
          oscillator.stop();
        } catch {}
      }
      sounding.delete(id);
    }
  for (const timer of current) {
    const key = timer.pluginId + ":" + timer.id + ":" + timer.startedAt;
    if (!played.has(key)) {
      played.add(key);
      tone(timer);
      if (timer.alert?.vibration && timer.alert.vibration !== "none")
        navigator.vibrate?.(
          timer.alert.vibration === "pulse" ? [150, 100, 150] : 150,
        );
    }
  }
  if (repeating) clearInterval(repeating);
  if (current.some((t) => t.alert?.repeat === "indefinite"))
    repeating = setInterval(
      () =>
        current.filter((t) => t.alert?.repeat === "indefinite").forEach(tone),
      2000,
    );
}

export async function pollTimerDismissals(
  dismiss: (pluginId: string, id: string) => void,
) {
  if (!Capacitor.isNativePlatform()) return;
  for (const timer of (await mobile.dismissed()).dismissed)
    dismiss(timer.pluginId, timer.id);
}
