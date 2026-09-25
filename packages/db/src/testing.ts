/**
 * Test helpers shared by packages that run integration tests against the docker-compose services.
 * Exported as `@linklens/db/testing`; never import this from production code.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { resolveDatabaseUrl, withDatabase } from "./env.js";
import { migrate } from "./migrate.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

/** Connection string for the docker-compose Postgres (the admin/maintenance database). */
export function adminUrl(): string {
  return resolveDatabaseUrl(process.env);
}

/** REDIS_URL from the environment / root .env. */
export function redisUrl(): string {
  const url = process.env["REDIS_URL"]?.trim();
  if (url === undefined || url === "") throw new Error("REDIS_URL is not set (see .env.example)");
  return url;
}

/** Create an empty, uniquely named database and return its URL. */
export async function createTempDatabase(prefix = "linklens_test"): Promise<string> {
  const name = `${prefix}_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return withDatabase(adminUrl(), name);
}

/** Create a temp database and apply all migrations. */
export async function createMigratedTempDatabase(): Promise<string> {
  const url = await createTempDatabase();
  await migrate(url, "up");
  return url;
}

/** Drop a database created by createTempDatabase (bypasses append-only triggers by design). */
export async function dropTempDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^linklens_test_\w+$/.test(name)) {
    throw new Error(`refusing to drop non-test database ${name}`);
  }
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
