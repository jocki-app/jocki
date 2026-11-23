import { createPortal } from "react-dom";
import { Toaster } from "./primitives/sonner";

/** Keep notifications outside content stacking contexts and clipping containers. */
export function ApplicationToaster() {
  return createPortal(
    <Toaster
      richColors
      closeButton
      expand
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          content: "min-w-0",
          title: "[overflow-wrap:anywhere]",
        },
      }}
    />,
    document.body,
  );
}
