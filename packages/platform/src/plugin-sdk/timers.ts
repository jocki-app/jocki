/** Local, explicitly submitted timers. Replicated records never schedule alarms. */
export interface TimerSubmission {
  id: string;
  title: string;
  startedAt: number;
  durationMs?: number;
  pausedAt?: number;
  pausedMs?: number;
  /** Larger numbers win on platforms with a single timer surface. */
  priority?: number;
  alert?: {
    tone: "none" | "chime" | "bell" | "gentle";
    repeat: "once" | "indefinite";
    vibration?: "none" | "short" | "pulse";
  };
}
export interface SubmittedTimer extends TimerSubmission {
  pluginId: string;
  /** Set durably by the local scheduler before playing an alert. */
  completedAt?: number;
}
export interface TimerService {
  /** Call from a user gesture before submitting an audible timer. */
  requestPermission(persistent?: boolean): Promise<boolean>;
  submit(timer: TimerSubmission): Promise<void>;
  remove(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  list(): SubmittedTimer[];
  subscribe(listener: () => void): () => void;
}
export interface TimerPresentation {
  timers: SubmittedTimer[];
  primary?: SubmittedTimer;
}
export interface TimerPlatform {
  present(value: TimerPresentation): Promise<void>;
  requestPermission(): Promise<boolean>;
}
