import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalise, db as q, fixes, makeConfig } from "@linklens/core";
import { asQueryable, createPool, resolveDatabaseUrl } from "@linklens/db";
import { EmbeddingWorker, embeddingOptions } from "@linklens/embeddings";
import { toCsv, type Cell } from "./corpus/csv.js";
import { gitState, readManifest, writeJsonAtomic } from "./corpus/manifest.js";
import { buildE3Inputs, loadE3Data } from "./e3-baselines.js";
import { loadRunInputs } from "./in-memory.js";
import { e6Rows, fixRows, poolRows, ratingRows, siteFeatures } from "./l13/dataset.js";
import { e3Comparison, learnedPayload, type SitePredictions } from "./l13/evaluate.js";
import { STRUCTURAL_FEATURES, fullGraph, graphRepeats } from "./l13/graph.js";
import { GRAPHS_VERSION, writeSiteGraphs } from "./l13/graph-files.js";
import { CATEGORICAL_FEATURES, FEATURES, NUMERIC_FEATURES } from "./l13/features.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_OUT = join(REPO, "results", "corpus");
export const L13_DATASET_VERSION = "l13-dataset@1.0.0";

const USAGE = `Usage: pnpm --filter @linklens/eval l13 <command> --batch <name> [--out <dir>]
  export     every completed site of a corpus batch: E6 label rows (masked repeats), fix rows,
             E3 pool rows and E8 rating rows, in <batch>/l13/dataset/<site>/ (+ dataset.json)
  graph-export  GraphSAGE inputs: per site, the unmasked graph and every E6 masked repeat
             (body edges, node features, E6 queries and candidate pairs) in <batch>/l13/graphs/
  graph-import  the GraphSAGE scores (<batch>/l13/gnn/predictions/<site>.json, from
             python -m ml gnn) as graphsage-scores artefacts
  import     the model's per-site predictions (<batch>/l13/model/predictions/<site>.json, from
             python -m ml train) as learned-priority artefacts, and E3 for S, learned and random
             (<batch>/l13/model/e3.csv)
Options: --out <dir> (batches live in <dir>/<name>; default results/corpus), --only a,b,
         --model <dir> (import; default <batch>/l13/model)
Environment (the repository's .env is read): DATABASE_URL, LINKLENS_CACHE_DIR.`;

const dotenv = join(REPO, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);
const env = process.env;
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const cacheDir = () => resolve(REPO, env["LINKLENS_CACHE_DIR"] ?? ".cache/linklens");

function parseArgs(argv: string[]): Map<string, string> {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i] as string;
    const v = argv[i + 1];
    if (!a.startsWith("--") || v === undefined) throw new Error(USAGE);
    opts.set(a.slice(2), v);
  }
  return opts;
}

/** Rows as CSV with the given leading columns, then the features (null → empty). */
function rowsCsv<R extends object>(lead: readonly string[], rows: readonly R[]): string {
  const cols = [...lead, ...FEATURES];
  return toCsv(cols, rows as unknown as Readonly<Record<string, Cell>>[]);
}

function batch(opts: Map<string, string>) {
  const id = opts.get("batch");
  if (id === undefined) throw new Error(USAGE);
  const dir = resolve(opts.get("out") ?? DEFAULT_OUT, id);
  const m = readManifest(dir);
  if (m === null) throw new Error(`${dir}: no batch manifest`);
  const only = opts.get("only")?.split(",");
  const sites = m.sites.filter(
    (s) =>
      s.status === "completed" && s.runId !== null && (only === undefined || only.includes(s.id)),
  );
  return { dir, m, sites };
}

async function exportDataset(opts: Map<string, string>): Promise<void> {
  const { dir, m, sites } = batch(opts);
  const out = join(dir, "l13", "dataset");
  const policy = m.audit.policy;
  const pool = createPool(resolveDatabaseUrl(env));
  const embedder = EmbeddingWorker.start(embeddingOptions(m.config, cacheDir()));
  const records: Record<string, unknown>[] = [];
  try {
    const db = asQueryable(pool);
    for (const s of sites) {
      const runId = s.runId as number;
      log(`${s.id}: run ${runId}…`);
      const inputs = await loadRunInputs(db, runId, policy);
      const e6 = await e6Rows(inputs, policy, embedder);
      const sf = siteFeatures(inputs, policy);
      const fixList = fixRows(sf, inputs.config);
      const e3 = await loadE3Data(db, runId, policy, embedder, m.audit.refVariant as "weighted");
      const poolList = poolRows(sf, e3, inputs.config);
      const ratings = await ratingRows(db, runId, policy, fixList);
      const siteDir = join(out, s.id);
      mkdirSync(siteDir, { recursive: true });
      const files: [string, string][] = [
        [
          "e6.csv",
          rowsCsv(["repeat", "query", "target", "donor", "label", "s_score", "sigma_hybrid"], e6),
        ],
        ["fixes.csv", rowsCsv(["fix_id", "donor", "target", "type", "rank_s", "s_score"], fixList)],
        ["pool.csv", rowsCsv(["entry_id", "donor", "target", "kind", "s_score"], poolList)],
        ["ratings.csv", rowsCsv(["fix_id", "raters", "relevance", "s_score"], ratings)],
      ];
      for (const [name, csv] of files) writeFileSync(join(siteDir, name), csv, "utf8");
      const queries = new Set(e6.map((r) => r.query)).size;
      log(
        `${s.id}: ${queries} E6 queries (${e6.length} rows), ${fixList.length} fixes, ${poolList.length} pool, ${ratings.length} rated`,
      );
      records.push({
        site: s.id,
        architectureClass: s.architectureClass,
        runId,
        queries,
        e6Rows: e6.length,
        fixes: fixList.length,
        pool: poolList.length,
        ratings: ratings.length,
        sha256: Object.fromEntries(
          files.map(([n, c]) => [n, createHash("sha256").update(c).digest("hex")]),
        ),
      });
    }
  } finally {
    await embedder.close();
    await pool.end();
  }
  const resolved = makeConfig(m.config);
  writeJsonAtomic(join(out, "dataset.json"), {
    version: L13_DATASET_VERSION,
    batch: m.batchId,
    policy,
    policyVersion: canonicalise.POLICIES[policy].version,
    createdAt: new Date().toISOString(),
    git: gitState(REPO),
    features: [...FEATURES],
    numeric: [...NUMERIC_FEATURES],
    categorical: [...CATEGORICAL_FEATURES],
    // Resolved against the defaults: a batch whose config predates a setting still gets it.
    lightgbm: resolved.l13Lightgbm,
    shapTop: resolved.l13ShapTop,
    ks: resolved.e6Ks,
    e3Ks: resolved.e3TopKs,
    seed: resolved.randomSeed,
    sites: records,
  });
  log(`dataset written to ${out}`);
}

async function importModel(opts: Map<string, string>): Promise<void> {
  const { dir, m, sites } = batch(opts);
  const modelDir = resolve(opts.get("model") ?? join(dir, "l13", "model"));
  const predDir = join(modelDir, "predictions");
  const available = new Set(existsSync(predDir) ? readdirSync(predDir) : []);
  const policy = m.audit.policy;
  const policyVersion = canonicalise.POLICIES[policy].version;
  const pool = createPool(resolveDatabaseUrl(env));
  const embedder = EmbeddingWorker.start(embeddingOptions(m.config, cacheDir()));
  const E3_COLUMNS = [
    "site",
    "architecture_class",
    "run_id",
    "k",
    "method",
    "totalDeltaPr",
    "selected",
    "targetsCovered",
  ] as const;
  const e3Rows: Record<(typeof E3_COLUMNS)[number], Cell>[] = [];
  try {
    const db = asQueryable(pool);
    for (const s of sites) {
      if (!available.has(`${s.id}.json`)) {
        log(`${s.id}: no predictions, skipped`);
        continue;
      }
      const p = JSON.parse(readFileSync(join(predDir, `${s.id}.json`), "utf8")) as SitePredictions;
      if (p.runId !== s.runId)
        throw new Error(`${s.id}: predictions are for run ${p.runId}, not ${s.runId}`);
      const artefact = await q.insertArtefact(db, {
        runId: p.runId,
        policyVersion,
        kind: fixes.LEARNED_ARTEFACT,
        payload: learnedPayload(p, policyVersion) as unknown as q.Json,
      });
      const inputs = await loadRunInputs(db, p.runId, policy);
      const e3 = await loadE3Data(db, p.runId, policy, embedder, m.audit.refVariant as "weighted");
      const e3Inputs = buildE3Inputs(e3, {
        epsilon: inputs.config.epsilon,
        alpha: inputs.config.alpha,
        sigma: inputs.config.sigmaVariant,
      });
      const priority = new Map(Object.entries(p.pool).map(([id, x]) => [id, x.priority]));
      for (const r of e3Comparison(
        e3Inputs,
        priority,
        inputs.config.e3TopKs,
        inputs.config.e3RandomDraws,
        inputs.config.randomSeed,
      )) {
        e3Rows.push({ site: s.id, architecture_class: s.architectureClass, run_id: p.runId, ...r });
      }
      log(
        `${s.id}: learned-priority artefact ${artefact.id} (${Object.keys(p.fixes).length} fixes)`,
      );
    }
  } finally {
    await embedder.close();
    await pool.end();
  }
  writeFileSync(join(modelDir, "e3.csv"), toCsv(E3_COLUMNS, e3Rows), "utf8");
  log(`E3 comparison written to ${join(modelDir, "e3.csv")}`);
}

async function exportGraphs(opts: Map<string, string>): Promise<void> {
  const { dir, m, sites } = batch(opts);
  const out = join(dir, "l13", "graphs");
  const policy = m.audit.policy;
  const resolved = makeConfig(m.config);
  const pool = createPool(resolveDatabaseUrl(env));
  const embedder = EmbeddingWorker.start(embeddingOptions(m.config, cacheDir()));
  const records: Record<string, unknown>[] = [];
  try {
    const db = asQueryable(pool);
    for (const s of sites) {
      const runId = s.runId as number;
      const started = performance.now();
      const inputs = await loadRunInputs(db, runId, policy);
      const full = await fullGraph(inputs, policy, embedder);
      const repeats = await graphRepeats(inputs, policy, embedder);
      const record = writeSiteGraphs(join(out, s.id), full, repeats);
      const exportMs = Math.round(performance.now() - started);
      const queries = repeats.reduce((a, r) => a + r.queries.length, 0);
      log(
        `${s.id}: ${full.nodes.length} nodes, ${full.src.length} body edges, ${repeats.length} repeats, ${queries} E6 queries (${exportMs} ms)`,
      );
      records.push({
        site: s.id,
        architectureClass: s.architectureClass,
        runId,
        exportMs,
        ...record,
      });
    }
  } finally {
    await embedder.close();
    await pool.end();
  }
  mkdirSync(out, { recursive: true });
  writeJsonAtomic(join(out, "graphs.json"), {
    version: GRAPHS_VERSION,
    batch: m.batchId,
    policy,
    policyVersion: canonicalise.POLICIES[policy].version,
    createdAt: new Date().toISOString(),
    git: gitState(REPO),
    structural: [...STRUCTURAL_FEATURES],
    graphsage: resolved.graphsage,
    ks: resolved.e6Ks,
    seed: resolved.randomSeed,
    e6Repeats: resolved.e6Repeats,
    sites: records,
  });
  log(`graphs written to ${out}`);
}

async function importGraphSage(opts: Map<string, string>): Promise<void> {
  const { dir, m, sites } = batch(opts);
  const gnnDir = resolve(opts.get("model") ?? join(dir, "l13", "gnn"));
  const predDir = join(gnnDir, "predictions");
  const available = new Set(existsSync(predDir) ? readdirSync(predDir) : []);
  const policy = m.audit.policy;
  const policyVersion = canonicalise.POLICIES[policy].version;
  const pool = createPool(resolveDatabaseUrl(env));
  try {
    const db = asQueryable(pool);
    for (const s of sites) {
      if (!available.has(`${s.id}.json`)) {
        log(`${s.id}: no GraphSAGE scores, skipped`);
        continue;
      }
      const p = JSON.parse(readFileSync(join(predDir, `${s.id}.json`), "utf8")) as Omit<
        fixes.GraphSageScores,
        "version" | "policyVersion"
      >;
      if (p.runId !== s.runId)
        throw new Error(`${s.id}: scores are for run ${p.runId}, not ${s.runId}`);
      const payload: fixes.GraphSageScores = {
        version: fixes.GRAPHSAGE_VERSION,
        runId: p.runId,
        policyVersion,
        model: p.model,
        nodes: p.nodes,
        repeats: p.repeats,
        fixes: p.fixes,
      };
      fixes.graphsageLookup(payload); // validates the arrays
      const artefact = await q.insertArtefact(db, {
        runId: p.runId,
        policyVersion,
        kind: fixes.GRAPHSAGE_ARTEFACT,
        payload: payload as unknown as q.Json,
      });
      log(`${s.id}: ${fixes.GRAPHSAGE_ARTEFACT} artefact ${artefact.id} (run ${p.runId})`);
    }
  } finally {
    await pool.end();
  }
}

const [command, ...rest] = process.argv.slice(2);
const main = async () => {
  const opts = parseArgs(rest);
  if (command === "export") await exportDataset(opts);
  else if (command === "import") await importModel(opts);
  else if (command === "graph-export") await exportGraphs(opts);
  else if (command === "graph-import") await importGraphSage(opts);
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
};
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
