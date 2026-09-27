import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalise, db as q, type SigmaVariant } from "@linklens/core";
import type { Corpus } from "./corpus.js";
import type { Embedder } from "@linklens/embeddings";
import { compareE3, loadE3Inputs } from "../e3-baselines.js";
import { compareStoredRuns } from "../e4-stability.js";
import { readExportDir } from "../e5-files.js";
import { calibrateRun, parseExports } from "../e5-screaming-frog.js";
import { maskingRecovery } from "../e6-masking.js";
import { loadRunInputs } from "../in-memory.js";
import { readImport, siteExportDir } from "./screaming-frog.js";
import {
  CHANNELS_COLUMNS,
  E3_COLUMNS,
  E4_COLUMNS,
  E4_PAGES_COLUMNS,
  E5_CATEGORIES_COLUMNS,
  E5_COLUMNS,
  E5_DISAGREEMENTS_COLUMNS,
  E6_COLUMNS,
  METRICS_COLUMNS,
  POLICY_PAIRS_COLUMNS,
  SITES_COLUMNS,
  STAGES_COLUMNS,
  toCsv,
  type Cell,
} from "./csv.js";
import type { ExportRecord, GitState, Manifest } from "./manifest.js";
import {
  channelMetrics,
  e3Metrics,
  e4Metrics,
  e5Metrics,
  e6Metrics,
  pairMetrics,
  runMetrics,
} from "./metrics.js";

type Row<C extends readonly string[]> = Record<C[number], Cell>;

export interface ExportResult {
  readonly record: ExportRecord;
  readonly metrics: number;
}

/**
 * Write the batch's tidy CSVs into `dir`:
 * - metrics.csv: one row per site × policy × metric (completed audits only);
 * - policy_pairs.csv: one row per site × pair of policies × metric (E1, completed audits only);
 * - channels.csv: one row per site × discovery channel × metric (E2, the audit's policy);
 * - e3.csv: one row per site × k × method × metric (E3, the audit's policy; needs `embedder`,
 *   the batch's embedding model, else it is written with its header only);
 * - e4.csv / e4_pages.csv: with the re-crawl wave (`recrawl`), each site whose two runs both
 *   completed, compared (one row per comparison × metric) and every page's class;
 * - e5.csv / e5_categories.csv / e5_disagreements.csv: each completed site with imported
 *   Screaming Frog exports (`corpus import-sf`), under P0 and the audit's policy: the metrics,
 *   every disagreement category explained, and every disagreement with its evidence;
 * - e6.csv: E6 link-masking recovery (needs `embedder`), one row per site × repeat × method ×
 *   metric;
 * - sites.csv: one row per site (status, run, crawl size, timings, commit, model hash);
 * - stages.csv: one row per site × pipeline stage (status, duration).
 * Rows follow the corpus order, then the policy order (P0–P5; pairs (P0,P1), (P0,P2), …), then
 * the metric order.
 */
export async function exportBatch(
  db: q.Queryable,
  manifest: Manifest,
  corpus: Pick<Corpus, "sites">,
  dir: string,
  git: GitState,
  log: (m: string) => void = () => undefined,
  embedder?: Embedder,
  recrawl?: Manifest | null,
): Promise<ExportResult> {
  const notes = new Map(corpus.sites.map((s) => [s.id, s.notes]));
  const batch = manifest.batchId;
  const policy = manifest.audit.policy;
  const metrics: Row<typeof METRICS_COLUMNS>[] = [];
  const sites: Row<typeof SITES_COLUMNS>[] = [];
  const stages: Row<typeof STAGES_COLUMNS>[] = [];
  const pairs: Row<typeof POLICY_PAIRS_COLUMNS>[] = [];
  const channels: Row<typeof CHANNELS_COLUMNS>[] = [];
  const e3: Row<typeof E3_COLUMNS>[] = [];
  const e6: Row<typeof E6_COLUMNS>[] = [];
  const e4: Row<typeof E4_COLUMNS>[] = [];
  const e4Pages: Row<typeof E4_PAGES_COLUMNS>[] = [];
  const second = new Map((recrawl?.sites ?? []).map((s) => [s.id, s]));
  const e5: Row<typeof E5_COLUMNS>[] = [];
  const e5Categories: Row<typeof E5_CATEGORIES_COLUMNS>[] = [];
  const e5Disagreements: Row<typeof E5_DISAGREEMENTS_COLUMNS>[] = [];
  if (embedder === undefined) log("no embedder: e3.csv has no rows");

  for (const s of manifest.sites) {
    const base = { batch_id: batch, site_id: s.id, architecture_class: s.architectureClass };
    let pagesFetched: number | null = null;
    let fetches: number | null = null;
    if (s.runId !== null) {
      const [pages, all, stageRows] = await Promise.all([
        q.listPages(db, s.runId, "crawl"),
        q.listFetches(db, s.runId),
        q.listAuditStages(db, s.runId),
      ]);
      pagesFetched = pages.length;
      fetches = all.length;
      for (const st of stageRows) {
        stages.push({
          ...base,
          run_id: s.runId,
          stage: st.stage,
          position: st.position,
          status: st.status,
          duration_ms: st.durationMs,
        });
      }
      if (s.status === "completed") {
        log(`${s.id}: metrics of run ${s.runId}`);
        const run = await runMetrics(
          db,
          s.runId,
          policy,
          manifest.audit.sigma as SigmaVariant,
          manifest.audit.refVariant === "unweighted" ? "unweighted" : "weighted",
        );
        for (const p of run.policies) {
          for (const m of p.metrics) {
            metrics.push({
              ...base,
              run_id: s.runId,
              policy: p.policy,
              policy_version: p.policyVersion,
              is_audit_policy: p.policy === policy,
              metric: m.metric,
              value: m.value,
            });
          }
        }
        if (embedder !== undefined) {
          const { inputs, config } = await loadE3Inputs(db, s.runId, policy, embedder, {
            sigma: manifest.audit.sigma as SigmaVariant,
            refVariant: manifest.audit.refVariant === "unweighted" ? "unweighted" : "weighted",
          });
          const result = compareE3(inputs, config.e3TopKs, config.e3RandomDraws, config.randomSeed);
          for (const m of e3Metrics(result)) {
            e3.push({
              ...base,
              run_id: s.runId,
              policy,
              policy_version: run.channels.policyVersion,
              k: m.k,
              method: m.method,
              metric: m.metric,
              value: m.value,
            });
          }
        }
        if (embedder !== undefined) {
          const inputs = await loadRunInputs(db, s.runId, policy);
          const recovery = await maskingRecovery(
            inputs,
            policy,
            embedder,
            inputs.config.randomSeed,
          );
          for (const m of e6Metrics(recovery)) {
            e6.push({
              ...base,
              run_id: s.runId,
              policy,
              repeat: m.repeat,
              seed: m.seed,
              method: m.method,
              metric: m.metric,
              value: m.value,
            });
          }
        }
        for (const c of channelMetrics(run.channels)) {
          channels.push({
            ...base,
            run_id: s.runId,
            policy,
            policy_version: run.channels.policyVersion,
            channel: c.channel,
            metric: c.metric,
            value: c.value,
          });
        }
        for (const p of run.pairs) {
          for (const m of pairMetrics(p)) {
            pairs.push({
              ...base,
              run_id: s.runId,
              policy_a: p.a,
              policy_b: p.b,
              top_k: run.k,
              metric: m.metric,
              value: m.value,
            });
          }
        }
      }
    }
    if (s.status === "completed" && s.runId !== null && readImport(dir, s.id) !== null) {
      log(`${s.id}: E5, run ${s.runId} vs Screaming Frog`);
      const inputs = await loadRunInputs(db, s.runId, policy);
      const exports = parseExports(readExportDir(siteExportDir(dir, s.id)));
      const policies: canonicalise.PolicyId[] = policy === "P0" ? ["P0"] : ["P0", policy];
      const calibration = calibrateRun(inputs, exports, policies, inputs.config);
      for (const c of calibration.policies) {
        for (const m of e5Metrics(c)) {
          e5.push({
            ...base,
            run_id: s.runId,
            policy: c.policy,
            policy_version: c.policyVersion,
            metric: m.metric,
            value: m.value,
          });
        }
        for (const k of c.categories) {
          e5Categories.push({
            ...base,
            policy: c.policy,
            kind: k.kind,
            category: k.category,
            count: k.count,
            share: k.share,
            large: k.large,
            explanation: k.explanation,
            examples: k.examples.join(" | "),
          });
        }
        for (const d of c.disagreements) {
          e5Disagreements.push({
            ...base,
            policy: c.policy,
            kind: d.kind,
            node: d.node,
            category: d.category,
            detail: JSON.stringify(d.detail),
          });
        }
      }
    }
    const again = second.get(s.id);
    if (
      s.status === "completed" &&
      s.runId !== null &&
      again?.status === "completed" &&
      again.runId !== null
    ) {
      log(`${s.id}: E4, run ${s.runId} vs re-crawl ${again.runId}`);
      const stability = await compareStoredRuns(db, s.runId, again.runId, {
        policyId: policy,
        sigma: manifest.audit.sigma as SigmaVariant,
      });
      const runs = { run_a: s.runId, run_b: again.runId };
      for (const m of e4Metrics(stability)) {
        e4.push({ ...base, ...runs, comparison: m.comparison, metric: m.metric, value: m.value });
      }
      for (const c of stability.classes) {
        e4Pages.push({ ...base, node: c.node, status: c.status, cause: c.cause, reason: c.reason });
      }
    }
    const duration =
      s.startedAt === null || s.finishedAt === null
        ? null
        : (Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 1000;
    sites.push({
      ...base,
      url: s.url,
      notes: notes.get(s.id) ?? "",
      status: s.status,
      run_id: s.runId,
      attempts: s.attempts,
      audit_policy: policy,
      pages_fetched: pagesFetched,
      fetches,
      started_at: s.startedAt,
      finished_at: s.finishedAt,
      duration_s: duration,
      commit: s.commit,
      model_sha256: s.modelSha256,
      error: s.error,
    });
  }

  const files = [
    { name: "metrics.csv", csv: toCsv(METRICS_COLUMNS, metrics), rows: metrics.length },
    { name: "channels.csv", csv: toCsv(CHANNELS_COLUMNS, channels), rows: channels.length },
    { name: "e3.csv", csv: toCsv(E3_COLUMNS, e3), rows: e3.length },
    { name: "e4.csv", csv: toCsv(E4_COLUMNS, e4), rows: e4.length },
    { name: "e4_pages.csv", csv: toCsv(E4_PAGES_COLUMNS, e4Pages), rows: e4Pages.length },
    { name: "e5.csv", csv: toCsv(E5_COLUMNS, e5), rows: e5.length },
    {
      name: "e5_categories.csv",
      csv: toCsv(E5_CATEGORIES_COLUMNS, e5Categories),
      rows: e5Categories.length,
    },
    {
      name: "e5_disagreements.csv",
      csv: toCsv(E5_DISAGREEMENTS_COLUMNS, e5Disagreements),
      rows: e5Disagreements.length,
    },
    { name: "e6.csv", csv: toCsv(E6_COLUMNS, e6), rows: e6.length },
    { name: "policy_pairs.csv", csv: toCsv(POLICY_PAIRS_COLUMNS, pairs), rows: pairs.length },
    { name: "sites.csv", csv: toCsv(SITES_COLUMNS, sites), rows: sites.length },
    { name: "stages.csv", csv: toCsv(STAGES_COLUMNS, stages), rows: stages.length },
  ];
  for (const f of files) writeFileSync(join(dir, f.name), f.csv);
  return {
    record: {
      at: new Date().toISOString(),
      git,
      files: files.map((f) => ({
        name: f.name,
        rows: f.rows,
        sha256: createHash("sha256").update(f.csv).digest("hex"),
      })),
    },
    metrics: metrics.length,
  };
}
