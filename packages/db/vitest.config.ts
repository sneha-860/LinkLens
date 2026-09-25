import { defineProject } from "vitest/config";

// Unit tests only. Integration tests (test/**/*.int.test.ts) need Docker: see vitest.integration.config.ts.
export default defineProject({
  test: {
    name: "db",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
