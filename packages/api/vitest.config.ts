import { defineProject } from "vitest/config";

// Unit tests (stubbed service). Pipeline tests against Postgres/Redis: vitest.integration.config.ts.
export default defineProject({
  test: {
    name: "api",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
