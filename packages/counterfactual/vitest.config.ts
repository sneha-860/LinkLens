import { defineProject } from "vitest/config";

// Unit tests (worker pool on in-memory graphs). Database tests: vitest.integration.config.ts.
export default defineProject({
  test: {
    name: "counterfactual",
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
