import "./dev-performance";
import { VaultLauncher } from "../packages/platform-browser/vault-runtime";
import React from "react";
import ReactDOM from "react-dom/client";
import { VaultEntry } from "../packages/app-ui/vault-entry";
import { LoadingSpinner } from "../packages/ui/loading-spinner";
import { ApplicationToaster } from "../packages/ui/application-toaster";
import { connectLogNotifications } from "../packages/ui/notifications";
import { logError } from "../packages/core/local-logs";
import { ApplicationBoundary } from "../packages/app-ui/errors";
import "./index.css";
const disconnectNotifications = connectLogNotifications(() =>
  window.dispatchEvent(new Event("jocki:open-logs")),
);
import.meta.hot?.dispose(disconnectNotifications);
window.addEventListener("error", (event) =>
  logError(event.error ?? event.message, "window"),
);
window.addEventListener("unhandledrejection", (event) =>
  logError(event.reason, "promise"),
);
if (
  import.meta.env.PROD &&
  /^https?:$/.test(location.protocol) &&
  "serviceWorker" in navigator
) {
  const registerOfflineShell = () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .catch((error) =>
        console.error("Offline shell registration failed", error),
      );
  };
  if (document.readyState === "complete") registerOfflineShell();
  else window.addEventListener("load", registerOfflineShell, { once: true });
}
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <ApplicationToaster />
    <LoadingSpinner label="Opening Jocki…" className="min-h-dvh" />
  </React.StrictMode>,
);
// Let the entry module finish evaluating before lazy platform imports load.
// Rollup may share entry exports with those chunks.
async function openApplication() {
  const launcher = await VaultLauncher.open();
  root.render(
    <React.StrictMode>
      <ApplicationToaster />
      <ApplicationBoundary>
        <VaultEntry launcher={launcher} />
      </ApplicationBoundary>
    </React.StrictMode>,
  );
}
void openApplication();
