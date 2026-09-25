import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db-integration",
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // One throwaway database per run; files share it, so run them serially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
