import type { ReactNode } from "react";
import { Button } from "../ui/primitives/button";

/** Shared landing layout for the application entry flows. */
export function StartScreen({
  busy = false,
  actions,
  children,
}: {
  busy?: boolean;
  actions: Array<{ title: string; onSelect(): void }>;
  children?: ReactNode;
}) {
  return (
    <main
      data-start-screen
      className="min-h-dvh flex items-center justify-center px-6 py-12"
    >
      <div className="w-full max-w-xl space-y-8">
        <img
          src="/jocki_icon.png"
          alt="Jocki"
          className="mx-auto h-auto w-80 max-w-full sm:w-96 object-contain"
        />
        <p className="text-center text-muted-foreground">
          Your workspace lives on this device. Work offline and synchronize with
          your approved devices.
        </p>
        <div className="grid grid-flow-col auto-cols-fr gap-3">
          {actions.map((action, index) => (
            <Button
              key={action.title}
              variant={index === 0 ? "default" : "outline"}
              disabled={busy}
              onClick={action.onSelect}
            >
              {action.title}
            </Button>
          ))}
        </div>
        {children}
      </div>
    </main>
  );
}
