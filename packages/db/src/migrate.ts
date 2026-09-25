import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
export const MIGRATIONS_TABLE = "pgmigrations";

/** Apply (or roll back) migrations programmatically. Returns the names of migrations run. */
export async function migrate(
  databaseUrl: string,
  direction: "up" | "down" = "up",
  count?: number,
): Promise<string[]> {
  const ran = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction,
    ...(count === undefined ? {} : { count }),
    checkOrder: true,
    singleTransaction: true,
    log: () => undefined,
  });
  return ran.map((m) => m.name);
}
