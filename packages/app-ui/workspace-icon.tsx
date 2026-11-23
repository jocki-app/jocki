import { PanelsTopLeft, type LucideProps } from "lucide-react";

/** One symbol for workspace identities, distinct from files and mounted folders. */
export function WorkspaceIcon({
  className = "size-4 shrink-0",
  ...props
}: LucideProps) {
  return (
    <PanelsTopLeft
      aria-hidden="true"
      data-workspace-icon
      className={className}
      {...props}
    />
  );
}
