import { defineProject } from "vitest/config";

// Unit tests only (a fake model). The real-model and database tests are in
// test/**/*.int.test.ts: see vitest.integration.config.ts.
export default defineProject({
  test: {
    name: "embeddings",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
