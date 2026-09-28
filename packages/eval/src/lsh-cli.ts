import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalise, db as q, makeConfig, semantic, type LinkLensConfig } from "@linklens/core";
import { CrawlOrchestrator } from "@linklens/crawler";
import { asQueryable, createPool, resolveDatabaseUrl } from "@linklens/db";
import { parseCorpus, resolveConfig } from "./corpus/corpus.js";
import { toCsv } from "./corpus/csv.js";
import { configSha256, gitState, writeJsonAtomic, type GitState } from "./corpus/manifest.js";
import {
  LSH_COLUMNS,
  LSH_EXPERIMENT_VERSION,
  capDocuments,
  evaluateCap,
  loadCapDocuments,
  lshRows,
  type CapResult,
  type LshRow,
} from "./lsh-prefilter.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_CORPUS = fileURLToPath(new URL("../corpus.yaml", import.meta.url));
const DEFAULT_OUT = join(REPO, "results", "lsh");
const MANIFEST = "manifest.json";

const USAGE = `Usage: pnpm --filter @linklens/eval lsh <command> --batch <name> [options]
  crawl  --sites <id,id,…>   crawl each corpus site once, at the largest cap of lshEvalCaps
                             (sequentially; run it again to resume an interrupted crawl)
  status                     each site's crawl
  run                        the experiment on every completed crawl: lsh.csv and lsh.json
                             (--no-brute-force skips the all-pairs loop; --only a,b)
Options:
  --corpus <file>            default packages/eval/corpus.yaml (sites, seed, config overrides)
  --out <dir>                batches live in <dir>/<name> (default results/lsh)
Environment (the repository's .env is read): DATABASE_URL or PG*, REDIS_URL, LINKLENS_PREFIX,
LINKLENS_USER_AGENT.`;

const dotenv = join(REPO, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

interface SiteState {
  readonly id: string;
  readonly url: string;
  readonly architectureClass: string;
  runId: number | null;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  pagesFetched: number | null;
  admitted: number | null;
  error: string | null;
}

interface LshManifest {
  readonly version: 1;
  readonly experiment: string;
  readonly batch: string;
  readonly createdAt: string;
  readonly corpus: string;
  readonly policy: canonicalise.PolicyId;
  readonly config: LinkLensConfig;
  readonly configSha256: string;
  readonly git: GitState;
  readonly sites: SiteState[];
  runs: { at: string; git: GitState; host: Record<string, unknown>; sites: string[] }[];
}

function parseArgs(argv: string[]): { flags: Set<string>; opts: Map<string, string> } {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.add(a.slice(2));
    else {
      opts.set(a.slice(2), next);
      i++;
    }
  }
  return { flags, opts };
}

function batchDir(opts: Map<string, string>): { id: string; dir: string } {
  const id = opts.get("batch");
  if (id === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("--batch <name> is required (letters, digits, '.', '_' and '-')");
  }
  return { id, dir: resolve(opts.get("out") ?? DEFAULT_OUT, id) };
}

function readManifest(dir: string): LshManifest | null {
  const path = join(dir, MANIFEST);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LshManifest) : null;
}

/**
 * The batch: created from --sites on the first crawl, then fixed. A crawl (new or resumed)
 * needs the same resolved config; `run` does not, since it evaluates each run with the config
 * stored on it.
 */
function openBatch(
  opts: Map<string, string>,
  checkConfig: boolean,
): { dir: string; m: LshManifest } {
  const { id, dir } = batchDir(opts);
  const existing = readManifest(dir);
  const file = resolve(opts.get("corpus") ?? DEFAULT_CORPUS);
  const corpus = parseCorpus(readFileSync(file, "utf8"));
  const base = resolveConfig(corpus, env["LINKLENS_USER_AGENT"]);
  const config = makeConfig({ ...base, pageCap: Math.max(...base.lshEvalCaps) });
  const wanted = opts
    .get("sites")
    ?.split(",")
    .filter((s) => s !== "");
  if (existing !== null) {
    if (checkConfig && existing.configSha256 !== configSha256(config)) {
      throw new Error(`${dir}: the resolved config changed since the batch was created`);
    }
    if (wanted !== undefined && wanted.join(",") !== existing.sites.map((s) => s.id).join(",")) {
      throw new Error(`${dir}: the batch has sites ${existing.sites.map((s) => s.id).join(",")}`);
    }
    return { dir, m: existing };
  }
  if (wanted === undefined || wanted.length === 0) throw new Error("--sites <id,id,…> is required");
  const sites = wanted.map((sid): SiteState => {
    const s = corpus.sites.find((x) => x.id === sid);
    if (s === undefined) throw new Error(`no site ${sid} in ${file}`);
    return {
      id: s.id,
      url: s.url,
      architectureClass: s.architectureClass,
      runId: null,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      pagesFetched: null,
      admitted: null,
      error: null,
    };
  });
  mkdirSync(dir, { recursive: true });
  const m: LshManifest = {
    version: 1,
    experiment: LSH_EXPERIMENT_VERSION,
    batch: id,
    createdAt: new Date().toISOString(),
    corpus: file,
    policy: corpus.policy,
    config: config as LinkLensConfig,
    configSha256: configSha256(config),
    git: gitState(REPO),
    sites,
    runs: [],
  };
  writeJsonAtomic(join(dir, MANIFEST), m);
  return { dir, m };
}

async function crawl(opts: Map<string, string>): Promise<void> {
  const { dir, m } = openBatch(opts, true);
  const save = () => writeJsonAtomic(join(dir, MANIFEST), m);
  const pool = createPool(resolveDatabaseUrl(env));
  const orchestrator = new CrawlOrchestrator({
    pool,
    redisUrl: env["REDIS_URL"] ?? "redis://localhost:6379",
    prefix: env["LINKLENS_PREFIX"] ?? "linklens",
  });
  let stopped = false;
  const stop = (signal: string) => {
    if (stopped) process.exit(130);
    stopped = true;
    log(`${signal}: detaching (the current crawl stays resumable)`);
    void orchestrator.shutdown();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  try {
    for (const site of m.sites) {
      if (stopped) break;
      if (site.status === "completed") continue;
      if (site.runId === null) {
        const { runId } = await orchestrator.createRun(site.url, {
          config: m.config,
          architectureClass: site.architectureClass,
        });
        site.runId = runId;
        site.startedAt = new Date().toISOString();
        site.status = "running";
        save();
        log(`${site.id}: run ${runId} created (cap ${m.config.pageCap})`);
      }
      const run = await q.getRun(asQueryable(pool), site.runId);
      const handle =
        run?.status === "running"
          ? await orchestrator.resume(site.runId)
          : await orchestrator.start(site.runId);
      let last = 0;
      handle.on("progress", (p: { pagesFetched: number; admitted: number }) => {
        if (p.pagesFetched - last >= 100) {
          last = p.pagesFetched;
          log(`${site.id}: ${p.pagesFetched} fetched, ${p.admitted} admitted`);
        }
      });
      const summary = await handle.done;
      if (summary.status === "detached") break;
      site.pagesFetched = summary.pagesFetched;
      site.admitted = summary.admitted;
      site.finishedAt = new Date().toISOString();
      site.status = summary.status === "completed" ? "completed" : "failed";
      site.error = summary.error ?? null;
      save();
      log(`${site.id}: ${summary.status}, ${summary.pagesFetched} pages fetched`);
    }
  } finally {
    if (!stopped) await orchestrator.shutdown();
    await pool.end();
  }
}

function status(opts: Map<string, string>): void {
  const { dir } = batchDir(opts);
  const m = readManifest(dir);
  if (m === null) throw new Error(`${dir}: no batch yet (run crawl --sites …)`);
  console.log(`${m.batch}: cap ${m.config.pageCap}, caps ${m.config.lshEvalCaps.join("/")}`);
  for (const s of m.sites) {
    console.log(
      `  ${s.id.padEnd(22)} ${s.status.padEnd(9)} run ${s.runId ?? "-"}  ${s.pagesFetched ?? "-"} pages`,
    );
  }
}

async function run(opts: Map<string, string>, flags: Set<string>): Promise<void> {
  const { dir, m } = openBatch(opts, false);
  const only = opts.get("only")?.split(",");
  const pool = createPool(resolveDatabaseUrl(env));
  const db = asQueryable(pool);
  const rows: LshRow[] = [];
  const results: { site: string; runId: number; admitted: number; caps: CapResult[] }[] = [];
  const host = {
    cpu: cpus()[0]?.model ?? null,
    cpus: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    platform: process.platform,
  };
  try {
    for (const site of m.sites) {
      if (only !== undefined && !only.includes(site.id)) continue;
      if (site.status !== "completed" || site.runId === null) {
        log(`${site.id}: crawl not completed, skipped`);
        continue;
      }
      const loaded = await loadCapDocuments(db, site.runId, m.policy);
      const caps: CapResult[] = [];
      for (const cap of [...loaded.config.lshEvalCaps].sort((a, b) => a - b)) {
        if (cap > loaded.admitted) {
          log(
            `${site.id}: only ${loaded.admitted} URLs admitted, so cap ${cap} is the whole crawl`,
          );
        }
        const docs = capDocuments(loaded.documents, loaded.rank, cap);
        log(`${site.id}: cap ${cap}, ${docs.length} documents…`);
        const r = evaluateCap(
          docs,
          cap,
          { runId: site.runId, policyVersion: loaded.policyVersion },
          loaded.config,
          {
            variants: semantic.REF_VARIANTS,
            bruteForce: !flags.has("no-brute-force"),
          },
        );
        caps.push(r);
        rows.push(
          ...lshRows(
            { siteId: site.id, runId: site.runId, policyVersion: loaded.policyVersion },
            r,
          ),
        );
        const w = r.variants[0];
        const t = w?.thresholds.find((x) => x.threshold === loaded.config.lshThreshold);
        log(
          `${site.id}: cap ${cap}: exact ${w?.ms.exact.toFixed(0)} ms, brute force ${w?.ms.bruteForce.toFixed(0)} ms, ` +
            `LSH ${t?.ms.total.toFixed(0)} ms, recall ${t?.recall?.toFixed(3)}`,
        );
      }
      results.push({ site: site.id, runId: site.runId, admitted: loaded.admitted, caps });
    }
  } finally {
    await pool.end();
  }
  writeFileSync(join(dir, "lsh.csv"), toCsv(LSH_COLUMNS, rows), "utf8");
  const g = gitState(REPO);
  m.runs.push({ at: new Date().toISOString(), git: g, host, sites: results.map((r) => r.site) });
  writeJsonAtomic(join(dir, MANIFEST), m);
  writeJsonAtomic(join(dir, "lsh.json"), {
    experiment: LSH_EXPERIMENT_VERSION,
    refVersion: semantic.REF_VERSION,
    params: semantic.lshParams(m.config),
    threshold: m.config.lshThreshold,
    thresholds: m.config.lshEvalThresholds,
    caps: m.config.lshEvalCaps,
    epsilon: m.config.epsilon,
    repeats: m.config.lshEvalRepeats,
    git: g,
    host,
    results,
  });
  log(`${rows.length} rows written to ${join(dir, "lsh.csv")}`);
}

const [command, ...rest] = process.argv.slice(2);
const { flags, opts } = parseArgs(rest);
const main = async () => {
  if (command === "crawl") await crawl(opts);
  else if (command === "status") status(opts);
  else if (command === "run") await run(opts, flags);
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
};
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
