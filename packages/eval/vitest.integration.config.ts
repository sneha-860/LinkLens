import { defineConfig } from "vitest/config";

// A throwaway Postgres database; the pipeline runs in-process (no model: a stub cosine matrix).
export default defineConfig({
  test: {
    name: "eval-integration",
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
