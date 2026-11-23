import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.jocki",
  appName: "Jocki",
  webDir: "dist",
  plugins: { CapacitorHttp: { enabled: true } },
};

export default config;
