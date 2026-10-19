import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Append-only tables, statically: the database triggers reject UPDATE, DELETE and TRUNCATE at
 * run time (schema.int.test.ts); these checks catch code that would try, at review time.
 */
const APPEND_ONLY = [
  "link_observations",
  "discovery_observations",
  "fetch_bodies",
  "analytics_clicks",
  "fix_ratings",
] as const;

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Source files (tests excluded: they try mutations on purpose) and every migration. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", "dist", "test", ".cache"].includes(e.name)) walk(p);
      } else if (/\.(ts|tsx|mts|sql)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(PACKAGES);
  return out;
}

describe("append-only tables", () => {
  const migrations = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");

  it.each(APPEND_ONLY)("%s has row and TRUNCATE triggers", (table) => {
    expect(migrations).toMatch(
      new RegExp(`CREATE TRIGGER ${table}_append_only\\s+BEFORE UPDATE OR DELETE ON ${table}`),
    );
    expect(migrations).toMatch(
      new RegExp(`CREATE TRIGGER ${table}_no_truncate\\s+BEFORE TRUNCATE ON ${table}`),
    );
  });

  it("is never updated, deleted, truncated or upserted by the code or a migration", () => {
    const tables = APPEND_ONLY.join("|");
    const mutation = new RegExp(
      `\\b(UPDATE\\s+(${tables})\\b|DELETE\\s+FROM\\s+(${tables})\\b|TRUNCATE\\s+(TABLE\\s+)?(${tables})\\b|INSERT\\s+INTO\\s+(${tables})\\b[^;]*ON\\s+CONFLICT[^;]*DO\\s+UPDATE)`,
      "i",
    );
    const offenders = sources().filter((f) => mutation.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(PACKAGES, f))).toEqual([]);
  });
});
