import { resolve } from "node:path";
import { createPool, resolveDatabaseUrl } from "@linklens/db";
import { EmbeddingWorker } from "@linklens/embeddings";
import { createApp } from "./app.js";
import { PipelineRunner, type Logger } from "./pipeline.js";

// Environment: DATABASE_URL (or the PG* variables; see @linklens/db), REDIS_URL, PORT,
// LINKLENS_CACHE_DIR (embeddings and model files), LINKLENS_PREFIX (Redis key prefix).
const env = process.env;
const logger: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ${m}`),
};

const pool = createPool(resolveDatabaseUrl(env));
const runner = new PipelineRunner({
  pool,
  redisUrl: env["REDIS_URL"] ?? "redis://localhost:6379",
  prefix: env["LINKLENS_PREFIX"] ?? "linklens",
  cacheDir: resolve(env["LINKLENS_CACHE_DIR"] ?? ".cache/linklens"),
  embedder: (options) => EmbeddingWorker.start(options),
  logger,
});
const port = Number(env["PORT"] ?? 3001);
const server = createApp({ service: runner, logger }).listen(port, () => {
  logger.info(`LinkLens API listening on http://localhost:${port} (docs: /docs)`);
  void runner.recover().then((ids) => {
    if (ids.length > 0) logger.info(`resuming audits ${ids.join(", ")}`);
  });
});

// Stop cleanly: crawls stay resumable (their state is in Redis), audits resume on the next start.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info(`${signal}: shutting down`);
    server.close();
    void runner.close().finally(() => pool.end());
  });
}
