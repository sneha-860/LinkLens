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
  },
});
