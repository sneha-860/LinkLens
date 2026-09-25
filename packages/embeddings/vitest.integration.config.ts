import { defineConfig } from "vitest/config";

// Real model (downloaded once into .cache/models) + a throwaway Postgres database.
export default defineConfig({
  test: {
    name: "embeddings-integration",
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
