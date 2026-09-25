import { defineProject } from "vitest/config";

// Unit tests. The experiments against a database: vitest.integration.config.ts.
export default defineProject({
  test: {
    name: "eval",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
