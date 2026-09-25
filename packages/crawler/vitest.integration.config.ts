import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "crawler-integration",
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
