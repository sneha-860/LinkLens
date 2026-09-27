import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asQueryable, createPool, resolveDatabaseUrl } from "@linklens/db";
import { EmbeddingWorker, embeddingOptions } from "@linklens/embeddings";
import { PipelineRunner } from "@linklens/api/pipeline";
import { runBatch } from "./corpus/batch.js";
import { parseCorpus, resolveConfig, sitesByClass } from "./corpus/corpus.js";
import { PipelineDriver } from "./corpus/driver.js";
import { exportBatch } from "./corpus/export.js";
import {
  MANIFEST_FILE,
  fileSha256,
  gitState,
  hostInfo,
  modelInfo,
  newManifest,
  markCrashedSessions,
  readManifest,
  resumeProblems,
  writeJsonAtomic,
  type Manifest,
  type Session,
} from "./corpus/manifest.js";
import { RECRAWL_DIR, acquireLock, recrawlPlan, scheduleCommands } from "./corpus/recrawl.js";
import { importExports, readImport } from "./corpus/screaming-frog.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_CORPUS = fileURLToPath(new URL("../corpus.yaml", import.meta.url));
const DEFAULT_OUT = join(REPO, "results", "corpus");

const USAGE = `Usage: pnpm --filter @linklens/eval corpus <command> [options]
  validate                     check corpus.yaml (no database needed)
  run      --batch <name>      audit every site in order; run it again to resume
  status   --batch <name>      each site's state (and its re-crawl, with due dates)
  recrawl  --batch <name>      E4: audit each site again e4RecrawlDays (14) after its first run
                               finished; only due sites run, so it is safe to schedule daily.
                               --now is the manual trigger (ignores the date)
  schedule --batch <name>      print the daily Task Scheduler / cron line for recrawl
                               (--at HH:MM, default 03:00); nothing is installed
  import-sf --batch <name> --site <id> --from <dir> [--sf-version <v>]
                               E5: check a site's Screaming Frog exports (internal_all.csv,
                               all_inlinks.csv, orphan_pages.csv) and copy them into the batch
  export   --batch <name>      write the tidy CSVs for analysis/ (e4 once re-crawled, e5 once
                               Screaming Frog exports are imported)
Options:
  --corpus <file>              default packages/eval/corpus.yaml
  --out <dir>                  batches live in <dir>/<name> (default results/corpus)
  --only <id,id,…>             run/recrawl: only these sites
  --retry-failed               run/recrawl: re-run sites whose audit failed
  --allow-code-change          run/recrawl: go on although the commit or working tree changed
Environment (the repository's .env is read): DATABASE_URL or PG*, REDIS_URL, LINKLENS_PREFIX,
LINKLENS_CACHE_DIR (embeddings and model files; default .cache/linklens), LINKLENS_USER_AGENT.`;

const dotenv = join(REPO, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;

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

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

function batchDir(opts: Map<string, string>): { id: string; dir: string } {
  const id = opts.get("batch");
  if (id === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("--batch <name> is required (letters, digits, '.', '_' and '-')");
  }
  return { id, dir: resolve(opts.get("out") ?? DEFAULT_OUT, id) };
}

const cacheDir = () => resolve(REPO, env["LINKLENS_CACHE_DIR"] ?? ".cache/linklens");
const modelDir = () => join(cacheDir(), "models");

function loadCorpus(opts: Map<string, string>) {
  const file = resolve(opts.get("corpus") ?? DEFAULT_CORPUS);
  return { file, corpus: parseCorpus(readFileSync(file, "utf8")) };
}

function validate(opts: Map<string, string>): void {
  const { file, corpus } = loadCorpus(opts);
  const config = resolveConfig(corpus, env["LINKLENS_USER_AGENT"]);
  console.log(`${relative(REPO, file)}: ${corpus.sites.length} sites, seed ${corpus.seed}`);
  for (const [cls, sites] of sitesByClass(corpus)) {
    console.log(`  ${cls}: ${sites.length} (${sites.map((s) => s.id).join(", ")})`);
  }
  console.log(
    `  policy ${corpus.policy}, σ ${corpus.sigma}, REF ${corpus.refVariant}, ` +
      `fixes ranked under ${corpus.rankAllPolicies ? "every policy" : corpus.policy}, ` +
      `pageCap ${config.pageCap}, re-crawl after ${config.e4RecrawlDays} days, ` +
      `User-Agent ${config.userAgent}`,
  );
}

/** A batch, or the re-crawl wave of one, ready to run. */
interface Wave {
  readonly id: string;
  readonly dir: string;
  readonly manifest: Manifest;
  readonly corpus: ReturnType<typeof parseCorpus>;
  readonly config: ReturnType<typeof resolveConfig>;
  readonly git: ReturnType<typeof gitState>;
}

/**
 * Create a batch's manifest, or check that an existing one can go on. A wave (the re-crawl) is
 * also checked against its first batch: same config, audit settings, versions, sites, model and
 * code, so both runs of a site are audited alike.
 */
function openWave(
  id: string,
  dir: string,
  opts: Map<string, string>,
  flags: Set<string>,
  wave?: { readonly of: Manifest; readonly afterDays: number },
): Wave | null {
  const { file, corpus } = loadCorpus(opts);
  const config = resolveConfig(corpus, env["LINKLENS_USER_AGENT"]);
  const git = gitState(REPO);
  const model = modelInfo(config, modelDir());
  const check = { corpus, config, git, allowCodeChange: flags.has("allow-code-change"), model };
  const problems = wave === undefined ? [] : resumeProblems(wave.of, check);
  let manifest = readManifest(dir);
  if (manifest !== null) problems.push(...resumeProblems(manifest, check));
  if (problems.length > 0) {
    console.error(`batch ${id} cannot go on:\n  ${problems.join("\n  ")}`);
    return null;
  }
  mkdirSync(dir, { recursive: true });
  if (manifest === null) {
    manifest = newManifest({
      batchId: id,
      corpus,
      corpusFile: relative(REPO, file).split("\\").join("/"),
      config,
      git,
      model,
      lockfileSha256: fileSha256(join(REPO, "pnpm-lock.yaml")),
      now: new Date().toISOString(),
      ...(wave === undefined ? {} : { wave: { of: wave.of.batchId, afterDays: wave.afterDays } }),
    });
    log(`batch ${id}: created in ${dir}`);
  } else {
    const crashed = markCrashedSessions(manifest);
    log(`batch ${id}: resuming${crashed > 0 ? ` (after ${crashed} crashed session(s))` : ""}`);
  }
  return { id, dir, manifest, corpus, config, git };
}

/** One session: audit the sites (all, or `only`) through the pipeline, saving the manifest. */
async function execute(w: Wave, flags: Set<string>, only?: readonly string[]): Promise<number> {
  const { id, dir, corpus, config, git } = w;
  const m = w.manifest;
  const save = (x: Manifest) => writeJsonAtomic(join(dir, MANIFEST_FILE), x);
  if (git.dirty)
    log("warning: the working tree has uncommitted changes (recorded in the manifest)");
  const session: Session = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    git,
    host: hostInfo(),
    outcome: "running",
  };
  m.sessions.push(session);
  save(m);

  const databaseUrl = resolveDatabaseUrl(env);
  const pool = createPool(databaseUrl);
  const runner = new PipelineRunner({
    pool,
    databaseUrl,
    redisUrl: env["REDIS_URL"] ?? "redis://localhost:6379",
    prefix: env["LINKLENS_PREFIX"] ?? "linklens",
    cacheDir: cacheDir(),
    embedder: (options) => EmbeddingWorker.start(options),
    logger: { info: log, error: (msg) => console.error(`${new Date().toISOString()} ${msg}`) },
  });
  const driver = new PipelineDriver(runner);
  let stopped = false;
  let closing: Promise<void> | null = null;
  const stop = (signal: string) => {
    if (stopped) {
      log(`${signal} again: exiting now`);
      process.exit(130);
    }
    stopped = true;
    log(`${signal}: stopping after saving state (the current site stays resumable)`);
    closing = driver.close();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  try {
    const summary = await runBatch(
      m,
      {
        policy: corpus.policy,
        sigma: corpus.sigma,
        refVariant: corpus.refVariant,
        rankAllPolicies: corpus.rankAllPolicies,
        config,
      },
      driver,
      {
        save,
        now: () => new Date().toISOString(),
        log,
        stopped: () => stopped,
        stamp: () => {
          const model = modelInfo(config, modelDir());
          if (model.sha256 !== null && model.sha256 !== m.model.sha256) {
            if (m.model.sha256 !== null) {
              log(`warning: the model files changed (${m.model.sha256} → ${model.sha256})`);
            }
            m.model = model;
          }
          const g = gitState(REPO);
          return {
            commit: g.commit === null ? null : `${g.commit}${g.dirty ? "-dirty" : ""}`,
            modelSha256: model.sha256,
          };
        },
      },
      {
        retryFailed: flags.has("retry-failed"),
        ...(only === undefined ? {} : { only }),
      },
    );
    session.outcome = summary.stopped ? "interrupted" : "finished";
    log(
      `batch ${id}: ${summary.completed} completed, ${summary.failed} failed, ` +
        `${summary.pending} pending${summary.stopped ? " (interrupted: run again to resume)" : ""}`,
    );
    return 0;
  } catch (e) {
    session.outcome = "error";
    session.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    session.finishedAt = new Date().toISOString();
    m.updatedAt = session.finishedAt;
    save(m);
    await (closing ?? driver.close());
    await pool.end();
  }
}

const onlyOf = (opts: Map<string, string>) =>
  opts.has("only") ? (opts.get("only") as string).split(",") : undefined;

async function run(opts: Map<string, string>, flags: Set<string>): Promise<number> {
  const { id, dir } = batchDir(opts);
  const w = openWave(id, dir, opts, flags);
  return w === null ? 2 : execute(w, flags, onlyOf(opts));
}

/**
 * E4's second wave, in `<batch>/recrawl`: each site again, `e4RecrawlDays` after its first run
 * finished. Only due sites run (an interrupted one is resumed whatever the date), so a daily
 * schedule is safe; a lock keeps two sessions from overlapping.
 */
async function recrawl(opts: Map<string, string>, flags: Set<string>): Promise<number> {
  const { id, dir } = batchDir(opts);
  const base = readManifest(dir);
  if (base === null) {
    console.error(`no batch ${id} in ${dir}`);
    return 2;
  }
  const waveDir = join(dir, RECRAWL_DIR);
  mkdirSync(waveDir, { recursive: true });
  const release = acquireLock(join(waveDir, ".lock"));
  if (release === null) {
    log(`batch ${id}: a re-crawl is already running; nothing to do`);
    return 0;
  }
  try {
    const afterDays = base.config.e4RecrawlDays;
    const w = openWave(`${id}-recrawl`, waveDir, opts, flags, { of: base, afterDays });
    if (w === null) return 2;
    const only = onlyOf(opts);
    const plan = recrawlPlan(base, w.manifest, new Date(), afterDays, {
      force: flags.has("now"),
      retryFailed: flags.has("retry-failed"),
      ...(only === undefined ? {} : { only }),
    });
    for (const x of plan.waiting) log(`${x.id}: re-crawl due ${x.dueAt}`);
    if (plan.due.length === 0) {
      writeJsonAtomic(join(waveDir, MANIFEST_FILE), w.manifest);
      log(`batch ${id}: no re-crawl is due (${plan.waiting.length} waiting)`);
      return 0;
    }
    log(`batch ${id}: re-crawling ${plan.due.join(", ")}`);
    return await execute(w, flags, plan.due);
  } finally {
    release();
  }
}

function schedule(opts: Map<string, string>): number {
  const { id, dir } = batchDir(opts);
  const at = opts.get("at") ?? "03:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error("--at must be HH:MM");
  const days = readManifest(dir)?.config.e4RecrawlDays;
  const c = scheduleCommands(
    REPO.replace(/[\\/]$/, ""),
    id,
    join(dir, RECRAWL_DIR, "recrawl.log"),
    at,
  );
  console.log(
    `# Re-crawl batch ${id} daily at ${at}. Each day it audits only the sites that are due`,
  );
  console.log(
    `# (${days ?? "e4RecrawlDays"} days after their first run) and exits at once otherwise.`,
  );
  console.log("# Windows (Task Scheduler):");
  console.log(c.windows);
  console.log("# macOS/Linux (crontab -e):");
  console.log(c.cron);
  console.log(`# Manual trigger: pnpm --filter @linklens/eval corpus recrawl --batch ${id} --now`);
  return 0;
}

function status(opts: Map<string, string>): number {
  const { id, dir } = batchDir(opts);
  const m = readManifest(dir);
  if (m === null) {
    console.error(`no batch ${id} in ${dir}`);
    return 2;
  }
  console.log(
    `batch ${id}: created ${m.createdAt}, ${m.sessions.length} session(s)` +
      `${m.finishedAt === null ? "" : `, finished ${m.finishedAt}`}`,
  );
  console.log(`  commit ${m.git.commit ?? "none"}${m.git.dirty ? " (dirty)" : ""}, seed ${m.seed}`);
  console.log(
    `  model ${m.model.name} ${m.model.dtype} sha256 ${m.model.sha256 ?? "(not downloaded yet)"}`,
  );
  const wave = readManifest(join(dir, RECRAWL_DIR));
  const pending = { sites: m.sites.map((s) => ({ ...s, status: "pending" as const })) };
  const plan = recrawlPlan(m, wave ?? pending, new Date(), m.config.e4RecrawlDays);
  const again = new Map((wave?.sites ?? []).map((s) => [s.id, s]));
  const dueAt = new Map(plan.waiting.map((x) => [x.id, x.dueAt]));
  const marked = new Set(
    loadCorpus(opts)
      .corpus.sites.filter((s) => s.screamingFrog)
      .map((s) => s.id),
  );
  for (const s of m.sites) {
    const r = again.get(s.id);
    const second =
      r !== undefined && r.status !== "pending"
        ? `  re-crawl ${r.status}${r.runId === null ? "" : ` (run ${r.runId})`}`
        : dueAt.has(s.id)
          ? `  re-crawl due ${dueAt.get(s.id)}`
          : "";
    const sf = marked.has(s.id)
      ? readImport(dir, s.id) === null
        ? "  Screaming Frog: exports missing"
        : "  Screaming Frog: imported"
      : "";
    console.log(
      `  ${s.status.padEnd(9)} ${s.id.padEnd(24)} ${String(s.runId ?? "-").padStart(5)} ` +
        `${s.architectureClass}${s.error === null ? "" : `  ${s.error}`}${second}${sf}`,
    );
  }
  return 0;
}

/** E5: check a site's three Screaming Frog exports and copy them into the batch. */
function importScreamingFrog(opts: Map<string, string>): number {
  const { corpus } = loadCorpus(opts);
  const { id, dir } = batchDir(opts);
  const site = opts.get("site");
  const from = opts.get("from");
  if (site === undefined || from === undefined) {
    throw new Error("import-sf needs --site <id> and --from <folder with the three CSVs>");
  }
  const entry = corpus.sites.find((s) => s.id === site);
  if (entry === undefined) throw new Error(`no site ${site} in the corpus`);
  if (readManifest(dir) === null) throw new Error(`no batch ${id} in ${dir}`);
  if (!entry.screamingFrog) {
    log(`warning: ${site} is not one of the corpus's Screaming Frog sites (screaming_frog: true)`);
  }
  const r = importExports(
    dir,
    site,
    resolve(from),
    new Date().toISOString(),
    opts.get("sf-version") ?? null,
  );
  for (const f of r.files) log(`${site}: ${f.name}: ${f.rows} rows, sha256 ${f.sha256}`);
  return 0;
}

async function exportCmd(opts: Map<string, string>): Promise<number> {
  const { corpus } = loadCorpus(opts);
  const { id, dir } = batchDir(opts);
  const m = readManifest(dir);
  if (m === null) {
    console.error(`no batch ${id} in ${dir}`);
    return 2;
  }
  const pool = createPool(resolveDatabaseUrl(env));
  // E3 embeds the orphans' pages with the batch's model (crawled pages come from the cache).
  const embedder = EmbeddingWorker.start(embeddingOptions(m.config, cacheDir()));
  try {
    const { record, metrics } = await exportBatch(
      asQueryable(pool),
      m,
      corpus,
      dir,
      gitState(REPO),
      log,
      embedder,
      readManifest(join(dir, RECRAWL_DIR)),
    );
    m.exports.push(record);
    writeJsonAtomic(join(dir, MANIFEST_FILE), m);
    for (const f of record.files) log(`${join(dir, f.name)}: ${f.rows} rows`);
    log(`batch ${id}: ${metrics} metric rows exported`);
    return 0;
  } finally {
    await embedder.close();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const { flags, opts } = parseArgs(rest);
    switch (command) {
      case "validate":
        validate(opts);
        return;
      case "run":
        process.exitCode = await run(opts, flags);
        return;
      case "recrawl":
        process.exitCode = await recrawl(opts, flags);
        return;
      case "schedule":
        process.exitCode = schedule(opts);
        return;
      case "status":
        process.exitCode = status(opts);
        return;
      case "import-sf":
        process.exitCode = importScreamingFrog(opts);
        return;
      case "export":
        process.exitCode = await exportCmd(opts);
        return;
      default:
        console.error(USAGE);
        process.exitCode = 2;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

void main();
