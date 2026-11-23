import type { ComponentProps, ReactNode } from "react";
import { ScopeTree } from "./vault-scope-tree";

/** History and sharing keep their content and bottom hierarchy independently scrollable. */
export function FeatureOverview({
  children,
  ...scope
}: ComponentProps<typeof ScopeTree> & { children: ReactNode }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden"
      data-feature-overview
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        data-feature-content
      >
        {children}
      </div>
      <ScopeTree {...scope} />
    </div>
  );
}
