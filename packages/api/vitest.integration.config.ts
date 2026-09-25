import { defineConfig } from "vitest/config";

// The whole pipeline through the HTTP API: throwaway Postgres + Redis (pnpm services:up) and the
// crawler's fixture site; embeddings come from a deterministic stub (no model download).
export default defineConfig({
  test: {
    name: "api-integration",
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
