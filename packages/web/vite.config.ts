import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3001", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // jsdom test files run in parallel, and user-event flows (typing, clicking through a tab)
    // take seconds when the machine is busy; the default 5 s flakes on a full workspace run.
    testTimeout: 20_000,
  },
});
