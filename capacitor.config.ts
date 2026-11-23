import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jocki.app",
  appName: "Jocki",
  webDir: "dist",
  plugins: { CapacitorHttp: { enabled: true } },
};

export default config;
