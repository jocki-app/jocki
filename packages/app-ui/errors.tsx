import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type ErrorInfo,
} from "react";
import { logError } from "../core/local-logs";
import { Button } from "../ui/primitives/button";
/** Keeps local error state for fallback rendering; the application reports it through Sonner. */
export function useReportedError(category: string) {
  const [error, setError] = useState("");
  const report = useCallback(
    (value: unknown) => {
      setError(String(value));
      logError(value, category);
    },
    [category],
  );
  return [error, report] as const;
}
export function ErrorToast({
  error,
  source = "editor",
}: {
  error: unknown;
  source?: string;
}) {
  useEffect(() => {
    logError(error, source);
  }, [error, source]);
  return null;
}
export class ApplicationBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    logError(error, "render");
  }
  render() {
    return this.state.failed ? (
      <main className="space-y-4 p-6">
        <h1>This view could not be opened.</h1>
        <Button onClick={() => location.reload()}>Reopen Jocki</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}
