import { defineConfig } from "vitest/config";

// A throwaway Postgres database.
export default defineConfig({
  test: {
    name: "counterfactual-integration",
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
