/** Read DATABASE_URL from the given environment, failing loudly if it is missing. */
export function resolveDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env (see README).");
  }
  return url;
}

/** Return a copy of `url` pointing at a different database name. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
