import {
  audit,
  canonicalise,
  db as q,
  diagnosis,
  discovery,
  fixes,
  graph,
  prominence,
  semantic,
  text,
} from "@linklens/core";
import { buildCounterfactualRun } from "@linklens/counterfactual";
import { buildCosineRun, type Embedder, type EmbeddingOptions } from "@linklens/embeddings";

/**
 * A deterministic stand-in for MiniLM with the same output size (384 dimensions by default): a
 * hashed bag of characters, L2-normalised. The cosine artefact's size depends only on the node
 * count and the dimensions, not on the model.
 */
export function hashingEmbedder(options: EmbeddingOptions, dimensions = 384): Embedder {
  return {
    options,
    embed: (requests) => {
      const vectors = requests.map(({ title, body }) => {
        const v = new Float32Array(dimensions);
        const s = `${title} ${body}`;
        for (let i = 0; i < s.length; i++) {
          const k = (s.charCodeAt(i) * 31 + i) % dimensions;
          v[k] = (v[k] ?? 0) + 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
      return Promise.resolve({
        vectors,
        keys: requests.map((_, i) => `hash:${i}`),
        dimensions,
        hits: 0,
        misses: requests.length,
      });
    },
  };
}

export interface StageTiming {
  readonly stage: string;
  readonly ms: number;
}

/**
 * The pipeline's database stages on a stored crawl, as the API runs them (graph → explanations;
 * no discovery fetches and no rescue, which fetch pages). Embeddings come from `embedder`.
 */
export async function runStoredPipeline(
  db: q.Queryable,
  runId: number,
  policy: canonicalise.PolicyId,
  embedder: Embedder,
  workers = 0,
): Promise<StageTiming[]> {
  const version = canonicalise.POLICIES[policy].version;
  const stages: [string, () => Promise<unknown>][] = [
    ["graph", () => graph.deriveGraph(db, runId, policy)],
    ["reconcile", () => discovery.reconcileDiscovery(db, runId, policy)],
    ["issues", () => audit.auditRun(db, runId, policy)],
    ["text", () => text.buildTextRun(db, runId, policy)],
    ["ref", () => semantic.buildRefRun(db, runId, policy, "weighted")],
    ["embeddings", () => buildCosineRun(db, runId, policy, embedder)],
    ["prominence", () => prominence.buildProminenceRun(db, runId, policy)],
    ["diagnosis", () => diagnosis.buildDiagnosisRun(db, runId, policy, "weighted")],
    ["candidates", () => fixes.buildCandidatesRun(db, runId, policy, "weighted")],
    ["counterfactual", () => buildCounterfactualRun(db, runId, policy, { workers })],
    [
      "kappa",
      async () => {
        const effort = await fixes.loadDonorEffort(db, runId, policy);
        const nodes = [...effort.values()].sort((a, b) => (a.node < b.node ? -1 : 1));
        await q.insertArtefact(db, {
          runId,
          policyVersion: version,
          kind: "donor-effort",
          payload: { nodes } as unknown as q.Json,
        });
      },
    ],
    ["scoring", () => fixes.buildFixRanking(db, runId, policy)],
    ["explanations", () => fixes.buildExplanations(db, runId, policy)],
  ];
  const timings: StageTiming[] = [];
  for (const [stage, fn] of stages) {
    const started = performance.now();
    await fn();
    timings.push({ stage, ms: performance.now() - started });
  }
  return timings;
}

export interface ArtefactSize {
  readonly kind: string;
  readonly policyVersion: string;
  /** Artefacts of this kind (the latest is measured). */
  readonly count: number;
  /** The JSON text of the latest one. */
  readonly jsonBytes: number;
  /** What Postgres stores for it (jsonb, TOAST-compressed). */
  readonly storedBytes: number;
}

/** The size of each artefact kind of a run (its latest artefact), largest first. */
export async function artefactSizes(db: q.Queryable, runId: number): Promise<ArtefactSize[]> {
  const { rows } = await db.query<{
    kind: string;
    policyVersion: string;
    count: number;
    jsonBytes: number;
    storedBytes: number;
  }>(
    `SELECT DISTINCT ON (kind, policy_version) kind, policy_version AS "policyVersion",
       count(*) OVER (PARTITION BY kind, policy_version)::int AS count,
       octet_length(payload::text)::int AS "jsonBytes",
       pg_column_size(payload)::int AS "storedBytes"
     FROM artefacts WHERE run_id = $1
     ORDER BY kind, policy_version, id DESC`,
    [runId],
  );
  return rows.sort((a, b) => b.jsonBytes - a.jsonBytes || (a.kind < b.kind ? -1 : 1));
}

export interface RawSize {
  readonly table: string;
  readonly rows: number;
  /** Sum of the rows' stored sizes (pg_column_size of the whole row). */
  readonly bytes: number;
}

/** The raw observation tables of a run: row counts and stored bytes. */
export async function rawSizes(db: q.Queryable, runId: number): Promise<RawSize[]> {
  const out: RawSize[] = [];
  for (const table of [
    "fetches",
    "pages",
    "link_observations",
    "discovery_observations",
    "fetch_bodies",
  ]) {
    const where =
      table === "fetch_bodies"
        ? "fetch_id IN (SELECT id FROM fetches WHERE run_id = $1)"
        : "run_id = $1";
    const { rows } = await db.query<{ rows: number; bytes: number }>(
      `SELECT count(*)::int AS rows, coalesce(sum(pg_column_size(t.*)), 0)::bigint::float8 AS bytes
       FROM ${table} t WHERE ${where}`,
      [runId],
    );
    out.push({ table, rows: rows[0]?.rows ?? 0, bytes: rows[0]?.bytes ?? 0 });
  }
  return out;
}

const kb = (n: number) => (n / 1024).toFixed(1);

/** A Markdown report of the measurements. */
export function sizesMarkdown(
  pages: number,
  artefacts: readonly ArtefactSize[],
  raw: readonly RawSize[],
  timings: readonly StageTiming[],
): string {
  const total = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  const lines = [
    `### Artefacts (${pages} pages, latest of each kind)`,
    "",
    "| kind | policy | JSON KiB | stored KiB |",
    "| ---- | ------ | -------: | ---------: |",
    ...artefacts.map(
      (a) => `| ${a.kind} | ${a.policyVersion} | ${kb(a.jsonBytes)} | ${kb(a.storedBytes)} |`,
    ),
    `| **total** | | **${kb(total(artefacts.map((a) => a.jsonBytes)))}** | **${kb(total(artefacts.map((a) => a.storedBytes)))}** |`,
    "",
    "### Raw observations",
    "",
    "| table | rows | KiB |",
    "| ----- | ---: | --: |",
    ...raw.map((r) => `| ${r.table} | ${r.rows} | ${kb(r.bytes)} |`),
    "",
    "### Stage timings",
    "",
    "| stage | ms |",
    "| ----- | -: |",
    ...timings.map((t) => `| ${t.stage} | ${t.ms.toFixed(0)} |`),
  ];
  return `${lines.join("\n")}\n`;
}
