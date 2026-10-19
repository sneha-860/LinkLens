import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db as q } from "@linklens/core";
import { startFixtureServer } from "@linklens/crawler/testing";
import { createPool, resolveDatabaseUrl } from "@linklens/db";
import { EmbeddingWorker } from "@linklens/embeddings";
import { PipelineRunner, type PipelineEvent } from "./pipeline.js";
import { pythonScorerFromEnv } from "./scorer.js";
import { fixesView, summaryView } from "./views.js";

// A demo audit of the crawler's fixture site (packages/crawler/test/fixtures/site): the site is
// served locally, audited through the same 21-stage PipelineRunner as the API, and summarised.
//   pnpm demo [--port 4010] [--keep]
// --keep leaves the fixture site running after the audit (Ctrl+C to stop), so the dashboard's
// links still resolve. Needs the Docker services, migrations and (first run) the MiniLM download.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const dotenv = resolve(REPO, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : fallback;
};
const port = Number(option("port", "4010"));
const keep = flag("keep");
const t0 = performance.now();
const log = (m: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const site = await startFixtureServer({ port });
log(`fixture site at ${site.origin}/ (robots.txt allows LinkLensBot, Crawl-delay 20 ms)`);

const databaseUrl = resolveDatabaseUrl(env);
const pool = createPool(databaseUrl);
const cacheDir = resolve(REPO, env["LINKLENS_CACHE_DIR"] ?? ".cache/linklens");
const runner = new PipelineRunner({
  pool,
  databaseUrl,
  redisUrl: env["REDIS_URL"] ?? "redis://localhost:6379",
  prefix: env["LINKLENS_PREFIX"] ?? "linklens",
  cacheDir,
  embedder: (options) => EmbeddingWorker.start(options),
  scorer: pythonScorerFromEnv(env, REPO, cacheDir),
  ...(env["LINKLENS_USER_AGENT"] === undefined
    ? {}
    : { defaultConfig: { userAgent: env["LINKLENS_USER_AGENT"] } }),
});

let id = -1;
const finished = new Promise<PipelineEvent & { type: "done" }>((done) => {
  runner.subscribe((e) => {
    if (e.runId !== id) return;
    if (e.type === "stage" && e.status === "completed") {
      const skipped = (e.detail as { skipped?: string } | null)?.skipped;
      log(
        `${e.stage} ${skipped === undefined ? `done (${e.durationMs.toFixed(0)} ms)` : `skipped: ${skipped}`}`,
      );
    } else if (e.type === "stage" && e.status === "failed") {
      log(`${e.stage} FAILED: ${e.error}`);
    } else if (e.type === "done") done(e);
  });
});
await runner.eventsReady();

try {
  const audit = await runner.create({ url: `${site.origin}/`, policy: "P3" });
  id = audit.runId;
  log(`audit ${id} started (policy P3, the default; 21 stages)`);
  const done = await finished;
  if (done.status !== "completed") throw new Error(`audit ${id} failed: ${done.error ?? "?"}`);

  const db = runner.db;
  const a = (await q.getAudit(db, id)) as q.AuditRow;
  const s = await summaryView(db, a, false);
  const view = await fixesView(db, a, "refGateCosine", 5, "global");
  const top = "fixes" in view ? view.fixes : [];
  const g = s.graph as { nodes?: number; edges?: number; reachable?: number } | null;
  console.log(`
Audit ${id} of ${s.url} — completed in ${(s.durationMs / 1000).toFixed(1)} s of stage time
  pages crawled      ${s.pages}
  link graph         ${g?.nodes ?? "?"} nodes, ${g?.edges ?? "?"} links, ${g?.reachable ?? "?"} reachable from the home page
  discovery          ${s.discovery?.inventory ?? "?"} URLs known, ${s.discovery?.orphans ?? "?"} orphans (found only outside the link graph)
  issues             ${s.issues?.total ?? "?"} (${Object.entries(s.issues?.byType ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")})
  diagnosis          ${
    s.diagnosis === null
      ? "?"
      : `v4 missing ${s.diagnosis.v4}, v3 buried ${s.diagnosis.v3}, v2 good ${s.diagnosis.v2}, v1 misleading ${s.diagnosis.v1}`
  }
  fixes ranked       ${s.fixes?.total ?? 0}

Top ${top.length} fixes by S = ΔPR × σ / κ:`);
  for (const f of top) {
    console.log(`  ${f.rank}. ${f.explanation?.sentence ?? `${f.type} ${f.donor} → ${f.target}`}`);
  }
  console.log(`
Explore it in the dashboard: pnpm start, then open http://localhost:3001/audits/${id}/summary`);
} finally {
  await runner.close();
  await pool.end();
  if (keep) {
    log(`fixture site still at ${site.origin}/ — Ctrl+C to stop`);
    process.once("SIGINT", () => void site.close().then(() => process.exit(0)));
  } else {
    await site.close();
  }
}
