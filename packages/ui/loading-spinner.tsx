import { LoaderCircle } from "lucide-react";
import { cn } from "./utils";

export function LoadingSpinner({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-live="polite"
      className={cn(
        "flex min-h-40 w-full items-center justify-center",
        className,
      )}
    >
      <LoaderCircle
        aria-hidden
        className="size-12 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    </div>
  );
}
