import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { syncErrorMessage } from "../sync/errors";
import {
  logError,
  logger,
  redactLog,
  subscribeLocalLogs,
} from "../core/local-logs";

export type NotificationKind = "success" | "error" | "info" | "warning";
const recentErrors = new Map<string, number>();
/** Validation errors can start with a JSON array; that first line alone is not a message. */
function logNotificationMessage(message: string) {
  const body = message.trim().replace(/^[A-Za-z]*Error:\s*/, "");
  const firstLine = body.split("\n")[0].trim();
  if (firstLine !== "[" && firstLine !== "{") return firstLine;
  try {
    // Read the complete pretty-printed JSON value before any browser-specific stack.
    const end = body.search(/\n[}\]](?:\r?\n|$)/);
    const details = JSON.parse(end < 0 ? body : body.slice(0, end + 2));
    const issues: unknown[] = Array.isArray(details) ? details : details.issues;
    if (Array.isArray(issues)) {
      const descriptions = issues.flatMap((issue) => {
        if (
          !issue ||
          typeof issue !== "object" ||
          !("message" in issue) ||
          typeof issue.message !== "string"
        )
          return [];
        const path =
          "path" in issue && Array.isArray(issue.path)
            ? issue.path
                .filter(
                  (part) =>
                    typeof part === "string" || typeof part === "number",
                )
                .join(".")
            : "";
        return [path ? `${path}: ${issue.message}` : issue.message];
      });
      if (descriptions.length)
        return (
          "Validation failed: " +
          descriptions.slice(0, 3).join("; ") +
          (descriptions.length > 3
            ? `; and ${descriptions.length - 3} more`
            : "")
        );
    }
  } catch {}
  return "Validation failed. Open Local logs for details.";
}
function show(kind: NotificationKind, value: unknown, onViewLogs?: () => void) {
  const message = (
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value == null
          ? ""
          : syncErrorMessage(value)
  )
    .trim()
    .replace(/^[A-Za-z]*Error: /, "");
  if (!message) return;
  if (kind === "error") {
    const now = Date.now(),
      previous = recentErrors.get(message);
    recentErrors.set(message, now);
    for (const [key, at] of recentErrors)
      if (now - at > 10000) recentErrors.delete(key);
    if (recentErrors.size > 100)
      recentErrors.delete(recentErrors.keys().next().value!);
    // Also covers a failure reported by both a child form and its caller.
    if (previous !== undefined && now - previous < 5000) return;
  }
  return toast[kind](message, {
    id: `jocki:${kind}:${message}`,
    ...(onViewLogs
      ? { action: { label: "View logs", onClick: onViewLogs } }
      : {}),
    duration: kind === "error" ? 8000 : 4000,
  });
}
/** Local UI feedback only. Never creates a replicated notification or executes a command. */
export const notify = {
  success: (message: string) => show("success", message),
  error: (error: unknown) => logError(error, "ui"),
  info: (message: string) => show("info", message),
  warning: (message: string) =>
    logger("ui").warn("{message}", { message: redactLog(message) }),
};

/** Install once at the application root. No notification code is needed at log sites. */
export function connectLogNotifications(onViewLogs?: () => void) {
  return subscribeLocalLogs((record) => {
    const kind =
      record.level === "error" || record.level === "fatal"
        ? "error"
        : record.level === "warning"
          ? "warning"
          : undefined;
    if (kind) show(kind, logNotificationMessage(record.message), onViewLogs);
  });
}

/** Track action state while reporting feedback through the app toaster. */
export function useNotificationState(
  kind: NotificationKind,
  initial = "",
): [string, (value: SetStateAction<string>) => void] {
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  useEffect(() => {
    if (initial) kind === "error" ? notify.error(initial) : show(kind, initial);
  }, []);
  const update = useCallback(
    (next: SetStateAction<string>) => {
      const message = typeof next === "function" ? next(current.current) : next;
      current.current = message;
      setValue(message);
      if (message)
        kind === "error" ? notify.error(message) : show(kind, message);
    },
    [kind],
  );
  return [value, update];
}
