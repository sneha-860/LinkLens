import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, resolveDatabaseUrl } from "@linklens/db";
import { EmbeddingWorker } from "@linklens/embeddings";
import { createApp } from "./app.js";
import { PipelineRunner, type Logger } from "./pipeline.js";

// Environment:
//   DATABASE_URL (or the PG* variables; see @linklens/db), REDIS_URL, PORT
//   LINKLENS_CACHE_DIR    embeddings and model files
//   LINKLENS_PREFIX       Redis key prefix (instances that share it share leases, events, throttle)
//   LINKLENS_USER_AGENT   overrides config.userAgent for new audits (needs a (+https://…) contact URL)
//   LINKLENS_API_KEY      when set, the API needs it (Bearer / X-API-Key, or the dashboard's session)
//   LINKLENS_WEB_ROOT     the built dashboard to serve at / (the API then moves under /api);
//                         defaults to packages/web/dist when it exists; "none" turns it off
// The repository's .env (as the migrations use), when there is one; real variables win.
const dotenv = new URL("../../../.env", import.meta.url);
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;
const logger: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ${m}`),
};

const databaseUrl = resolveDatabaseUrl(env);
const pool = createPool(databaseUrl);
const runner = new PipelineRunner({
  pool,
  databaseUrl,
  redisUrl: env["REDIS_URL"] ?? "redis://localhost:6379",
  prefix: env["LINKLENS_PREFIX"] ?? "linklens",
  cacheDir: resolve(env["LINKLENS_CACHE_DIR"] ?? ".cache/linklens"),
  embedder: (options) => EmbeddingWorker.start(options),
  ...(env["LINKLENS_USER_AGENT"] === undefined
    ? {}
    : { defaultConfig: { userAgent: env["LINKLENS_USER_AGENT"] } }),
  logger,
});

const builtWeb = new URL("../../web/dist/", import.meta.url);
const webSetting = env["LINKLENS_WEB_ROOT"];
const webRoot =
  webSetting === "none"
    ? undefined
    : webSetting !== undefined
      ? resolve(webSetting)
      : existsSync(new URL("index.html", builtWeb))
        ? fileURLToPath(builtWeb)
        : undefined;
const apiKey = env["LINKLENS_API_KEY"];
if (apiKey === undefined || apiKey === "")
  logger.info("LINKLENS_API_KEY is not set: the API is open to anyone who can reach it");

const port = Number(env["PORT"] ?? 3001);
const server = createApp({
  service: runner,
  logger,
  ...(apiKey === undefined ? {} : { apiKey }),
  ...(webRoot === undefined ? {} : { webRoot }),
}).listen(port, () => {
  const base = webRoot === undefined ? "" : "/api";
  logger.info(
    `LinkLens API listening on http://localhost:${port}${base} (docs: ${base}/docs)` +
      (webRoot === undefined ? "" : `; dashboard at http://localhost:${port}/`),
  );
  void runner.recover().then(({ audits, policyJobs }) => {
    if (audits.length > 0) logger.info(`resuming audits ${audits.join(", ")}`);
    if (policyJobs.length > 0) logger.info(`resuming policy jobs ${policyJobs.join(", ")}`);
  });
});

// Stop cleanly: crawls stay resumable (their state is in Redis), leases are given back, and
// audits resume on the next start (here or in another instance).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info(`${signal}: shutting down`);
    server.close();
    void runner.close().finally(() => pool.end());
  });
}
