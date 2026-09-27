import {
  audit as auditCore,
  canonicalise,
  db as q,
  diagnosis,
  discovery,
  fixes,
  graph,
  prominence,
  semantic,
  stats,
  text,
  type SigmaVariant,
} from "@linklens/core";
import type { E3Method, E3Result } from "../e3-baselines.js";
import { E6_METHODS, type E6Method, type E6Result } from "../e6-masking.js";
import { DISAGREEMENT_KINDS, type PolicyCalibration } from "../e5-screaming-frog.js";
import {
  COMPARISONS,
  METHOD_REASONS,
  SITE_REASONS,
  type ComparisonName,
  type Stability,
} from "../e4-stability.js";

type PolicyId = canonicalise.PolicyId;

/** One value of one metric (a row of the tidy export, before the site columns). */
export interface Metric {
  readonly metric: string;
  readonly value: number;
}

/** A node of the policy's graph, as far as the metrics need it. */
export interface NodeMetrics {
  readonly crawled: boolean;
  readonly reachable: boolean;
  readonly depth: number | null;
  readonly pagerank: number;
}

/** Everything the metrics of one run under one policy are computed from. */
export interface PolicyInputs {
  readonly graph: graph.GraphSummary;
  readonly nodes: readonly NodeMetrics[];
  readonly reconciliation: Pick<discovery.Reconciliation, "inventory" | "orphans" | "channels">;
  readonly audit: auditCore.AuditSummary;
  readonly diagnosis: diagnosis.DiagnosisReport["counts"];
  /** REF entries above ε (the stored matrix). */
  readonly refEntries: number;
  /** Against the audit's policy (E1), pages matched in P3 form. */
  readonly comparison: stats.PolicyComparison;
  /** The latest ranking under this policy with the audit's σ, if one was computed. */
  readonly ranking: Pick<fixes.FixRanking, "counts" | "fixes"> | null;
  /** The latest orphan rescue under this policy, if one was computed. */
  readonly rescue: {
    readonly orphans: readonly Pick<fixes.RescuedOrphan, "status" | "donors">[];
  } | null;
  /** Top k for the fix metrics (config.fixTopK). */
  readonly k: number;
}

/**
 * Gini coefficient of non-negative values (0: all equal; → 1: one value holds everything);
 * null for no values or a zero sum.
 */
export function gini(values: readonly number[]): number | null {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  const sum = xs.reduce((s, x) => s + x, 0);
  if (n === 0 || sum <= 0) return null;
  let acc = 0;
  xs.forEach((x, i) => {
    acc += (2 * (i + 1) - n - 1) * x;
  });
  return acc / (n * sum);
}

const mean = (xs: readonly number[]) =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

/**
 * Pure: the metrics of one run under one policy, in a fixed order. A metric that has no value
 * (a ratio over nothing, fixes never ranked under this policy) is left out, never written as 0.
 *
 * Names are `<group>.<metric>`: graph, discovery, audit, ref, diagnosis, sensitivity (against
 * the audit's policy), fixes and rescue.
 */
export function policyMetrics(p: PolicyInputs): Metric[] {
  const out: Metric[] = [];
  const put = (metric: string, value: number | boolean | null | undefined) => {
    if (value === null || value === undefined) return;
    const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (Number.isFinite(v)) out.push({ metric, value: v });
  };

  // Link graph.
  const g = p.graph;
  const crawled = p.nodes.filter((n) => n.crawled);
  const depths = p.nodes.flatMap((n) => (n.depth === null ? [] : [n.depth]));
  const crawledDepths = crawled.flatMap((n) => (n.depth === null ? [] : [n.depth]));
  put("graph.nodes", g.nodes);
  put("graph.crawled_pages", crawled.length);
  put("graph.edges", g.edges);
  put("graph.weighted_edges", g.weightedEdges);
  put("graph.self_loops", g.selfLoops);
  put("graph.external_links", g.externalLinks);
  put("graph.duplicate_page_links", g.duplicatePageLinks);
  put("graph.edges_per_crawled_page", ratio(g.edges, crawled.length));
  put("graph.reachable", g.reachable);
  put("graph.reachable_share", ratio(g.reachable, g.nodes));
  put("graph.crawled_unreachable", crawled.filter((n) => !n.reachable).length);
  put("graph.scc_count", g.sccCount);
  put("graph.largest_scc", g.largestSccSize);
  put("graph.largest_scc_share", ratio(g.largestSccSize, g.nodes));
  put("graph.mean_depth", mean(depths));
  put("graph.median_depth", median(depths));
  put("graph.max_depth", depths.length === 0 ? null : Math.max(...depths));
  put("graph.crawled_mean_depth", mean(crawledDepths));
  put("graph.pagerank_gini", gini(p.nodes.map((n) => n.pagerank)));
  put(
    "graph.pagerank_max",
    p.nodes.length === 0 ? null : Math.max(...p.nodes.map((n) => n.pagerank)),
  );
  put("graph.pagerank_iterations", g.pagerank.iterations);
  put("graph.pagerank_converged", g.pagerank.converged);

  // Discovery reconciliation.
  const rec = p.reconciliation;
  put("discovery.inventory", rec.inventory.length);
  put("discovery.orphans", rec.orphans.length);
  put("discovery.orphan_share", ratio(rec.orphans.length, rec.inventory.length));
  for (const c of discovery.DISCOVERY_CHANNELS) {
    const s = rec.channels[c];
    put(`discovery.${c}.total`, s.total);
    put(`discovery.${c}.exclusive`, s.exclusive);
    put(`discovery.${c}.orphans`, s.orphans);
  }

  // Structural audit.
  const a = p.audit;
  put("audit.issues", a.total);
  put("audit.nodes_with_issues", a.nodesWithIssues);
  put("audit.pages_audited", a.pagesAudited);
  put("audit.nodes_with_issues_share", ratio(a.nodesWithIssues, a.pagesAudited));
  for (const t of auditCore.ISSUE_TYPES) put(`audit.type.${t}`, a.byType[t]);
  for (const s of auditCore.SEVERITIES) put(`audit.severity.${s}`, a.bySeverity[s]);
  for (const [rule, n] of Object.entries(a.byRule).sort(([x], [y]) => (x < y ? -1 : 1))) {
    put(`audit.rule.${rule}`, n);
  }
  put("audit.weak_authority_threshold", a.thresholds.weakAuthorityThreshold);

  // REF and the four-case diagnosis.
  const d = p.diagnosis;
  put("ref.entries", p.refEntries);
  put("diagnosis.pairs", d.pairs);
  for (const c of diagnosis.CASES) put(`diagnosis.${c}`, d[c]);
  put("diagnosis.unclassified", d.unclassified);
  put("diagnosis.skipped_no_text", d.skippedNoText);
  const classified = diagnosis.CASES.reduce((s, c) => s + d[c], 0);
  for (const c of diagnosis.CASES) put(`diagnosis.${c}_share`, ratio(d[c], classified));

  // Sensitivity to the policy (E1): against the audit's policy.
  const cmp = p.comparison;
  put("sensitivity.pagerank_spearman", cmp.pagerankSpearman);
  put("sensitivity.mean_depth_shift", cmp.meanDepthShift);
  put("sensitivity.mean_abs_depth_shift", cmp.meanAbsDepthShift);
  put("sensitivity.top_fixes_jaccard", cmp.topFixesJaccard);

  // Fixes (only where a ranking exists under this policy).
  if (p.ranking !== null) {
    const all = p.ranking.fixes;
    const top = all.slice(0, p.k);
    put("fixes.count", p.ranking.counts.fixes);
    put("fixes.targets", p.ranking.counts.targets);
    put("fixes.add_link_share", ratio(all.filter((f) => f.type === "add-link").length, all.length));
    put("fixes.top_k", top.length);
    put("fixes.top_k_mean_delta_pr", mean(top.map((f) => f.deltaPr)));
    put("fixes.top_k_mean_score", mean(top.map((f) => f.score)));
    put("fixes.top_k_mean_kappa", mean(top.map((f) => f.kappa)));
    put(
      "fixes.top_k_newly_reachable",
      top.filter((f) => f.depthBefore === null && f.depthAfter !== null).length,
    );
    put(
      "fixes.top_k_mean_depth_gain",
      mean(top.flatMap((f) => (f.deltaDepth === null ? [] : [-f.deltaDepth]))),
    );
  }

  // Orphan rescue (only where it ran under this policy).
  if (p.rescue !== null) {
    const o = p.rescue.orphans;
    put("rescue.orphans", o.length);
    put("rescue.scored", o.filter((x) => x.status === "scored").length);
    put("rescue.with_donor", o.filter((x) => x.donors.length > 0).length);
    put("rescue.with_donor_share", ratio(o.filter((x) => x.donors.length > 0).length, o.length));
  }
  return out;
}

export interface PolicyMetrics {
  readonly policy: PolicyId;
  readonly policyVersion: string;
  readonly metrics: Metric[];
}

/** The E1 pair metrics, as the tidy export names them (fixed order). */
export const PAIR_METRICS = [
  ["nodes_a", "nodesA"],
  ["nodes_b", "nodesB"],
  ["node_delta", "nodeDelta"],
  ["node_ratio", "nodeRatio"],
  ["shared_nodes", "sharedNodes"],
  ["node_jaccard", "nodeJaccard"],
  ["orphans_a", "orphansA"],
  ["orphans_b", "orphansB"],
  ["orphan_jaccard", "orphanJaccard"],
  ["pagerank_spearman", "pagerankSpearman"],
  ["depth_pages", "depthPages"],
  ["mean_depth_shift", "meanDepthShift"],
  ["mean_abs_depth_shift", "meanAbsDepthShift"],
  ["max_abs_depth_shift", "maxAbsDepthShift"],
  ["top_fixes_jaccard", "topFixesJaccard"],
] as const satisfies readonly (readonly [string, keyof stats.PolicyPairComparison])[];

/** Pure: one pair's metrics; those without a value (null) are left out. */
export function pairMetrics(p: stats.PolicyPairComparison): Metric[] {
  return PAIR_METRICS.flatMap(([metric, key]) => {
    const value = p[key];
    return value === null || !Number.isFinite(value) ? [] : [{ metric, value }];
  });
}

/** One E2 value: a channel ("all" for the site's totals), a metric and its value. */
export interface ChannelMetric {
  readonly channel: discovery.DiscoveryChannel | "all";
  readonly metric: string;
  readonly value: number;
}

/**
 * Pure (E2): the leave-one-channel-out result as tidy values. Per channel: pages_total,
 * pages_exclusive (marginal page yield), orphans_total, orphans_exclusive (marginal orphan
 * yield: detected only by it), orphans_exclusive_share, inventory_without, orphans_without.
 * "all": inventory, orphans, orphans_several_channels. A share without orphans is left out.
 */
export function channelMetrics(loo: discovery.ChannelLeaveOneOut): ChannelMetric[] {
  const out: ChannelMetric[] = [
    { channel: "all", metric: "inventory", value: loo.inventory },
    { channel: "all", metric: "orphans", value: loo.orphans },
    { channel: "all", metric: "orphans_several_channels", value: loo.orphansBy.several },
  ];
  for (const r of loo.removals) {
    const put = (metric: string, value: number | null) => {
      if (value !== null) out.push({ channel: r.channel, metric, value });
    };
    put("pages_total", r.pagesTotal);
    put("pages_exclusive", r.pagesExclusive);
    put("orphans_total", r.orphansTotal);
    put("orphans_exclusive", r.orphansExclusive);
    put("orphans_exclusive_share", r.orphansExclusiveShare);
    put("inventory_without", r.inventoryWithout);
    put("orphans_without", r.orphansWithout);
  }
  return out;
}

/** One E3 value: k and method (null k and "site" for the site-level values). */
export interface E3Metric {
  readonly k: number | null;
  readonly method: E3Method | "site";
  readonly metric: string;
  readonly value: number;
}

/**
 * Pure (E3): the result as tidy values. Site: targets_weak, targets_orphan, pool_pairs,
 * pool_weak_pairs, pool_orphan_pairs, weak_targets_with_donors, orphan_targets_with_donors,
 * target_pagerank_before. Per k × method: total_delta_pr (the measure), total_delta_pr_sd
 * (random), selected, targets_covered, sum_single_delta_pr, delta_pr_l1, newly_reachable,
 * mean_ref, mean_cosine (null values left out).
 */
export function e3Metrics(r: E3Result): E3Metric[] {
  const site = (metric: string, value: number): E3Metric => ({
    k: null,
    method: "site",
    metric,
    value,
  });
  const out: E3Metric[] = [
    site("targets_weak", r.targets.weak),
    site("targets_orphan", r.targets.orphan),
    site("pool_pairs", r.pool.pairs),
    site("pool_weak_pairs", r.pool.weakPairs),
    site("pool_orphan_pairs", r.pool.orphanPairs),
    site("weak_targets_with_donors", r.pool.weakTargetsWithDonors),
    site("orphan_targets_with_donors", r.pool.orphanTargetsWithDonors),
    site("target_pagerank_before", r.targetPagerankBefore),
  ];
  for (const { k, methods } of r.byK) {
    for (const m of methods) {
      const put = (metric: string, value: number | null) => {
        if (value !== null && Number.isFinite(value))
          out.push({ k, method: m.method, metric, value });
      };
      put("total_delta_pr", m.totalDeltaPr);
      put("total_delta_pr_sd", m.totalDeltaPrSd);
      put("selected", m.selected);
      put("targets_covered", m.targetsCovered);
      put("sum_single_delta_pr", m.sumSingleDeltaPr);
      put("delta_pr_l1", m.deltaPrL1);
      put("newly_reachable", m.newlyReachable);
      put("mean_ref", m.meanRef);
      put("mean_cosine", m.meanCosine);
    }
  }
  return out;
}

/** One E4 value: a comparison ("pages" for the page classes), a metric and its value. */
export interface E4Metric {
  readonly comparison: ComparisonName | "pages";
  readonly metric: string;
  readonly value: number;
}

/**
 * Pure (E4): the result as tidy values. "pages": days_apart, union, unchanged, changed, only_a,
 * only_b, site_<reason>, method_<reason>, site_change_share, method_share, docs_unchanged,
 * docs_changed, docs_only_a, docs_only_b. Each comparison: node_jaccard, pagerank_spearman,
 * orphan_jaccard, top_fixes_jaccard, crawled_a, crawled_b, shared_nodes, orphans_a, orphans_b,
 * fixes_a, fixes_b (null values left out).
 */
export function e4Metrics(s: Stability): E4Metric[] {
  const out: E4Metric[] = [];
  const put = (comparison: E4Metric["comparison"], metric: string, value: number | null) => {
    if (value !== null && Number.isFinite(value)) out.push({ comparison, metric, value });
  };
  put("pages", "days_apart", s.daysApart);
  put("pages", "union", s.pages.union);
  put("pages", "unchanged", s.pages.unchanged);
  put("pages", "changed", s.pages.changed);
  put("pages", "only_a", s.pages.onlyA);
  put("pages", "only_b", s.pages.onlyB);
  for (const r of SITE_REASONS) put("pages", `site_${r}`, s.pages.site[r]);
  for (const r of METHOD_REASONS) put("pages", `method_${r}`, s.pages.method[r]);
  put("pages", "site_change_share", s.siteChangeShare);
  put("pages", "method_share", s.methodShare);
  put("pages", "docs_unchanged", s.discoveryDocuments.unchanged);
  put("pages", "docs_changed", s.discoveryDocuments.changed);
  put("pages", "docs_only_a", s.discoveryDocuments.onlyA);
  put("pages", "docs_only_b", s.discoveryDocuments.onlyB);
  for (const name of COMPARISONS) {
    const c = s.comparisons[name];
    put(name, "node_jaccard", c.nodeJaccard);
    put(name, "pagerank_spearman", c.pagerankSpearman);
    put(name, "orphan_jaccard", c.orphanJaccard);
    put(name, "top_fixes_jaccard", c.topFixesJaccard);
    put(name, "crawled_a", c.crawledA);
    put(name, "crawled_b", c.crawledB);
    put(name, "shared_nodes", c.sharedNodes);
    put(name, "orphans_a", c.orphansA);
    put(name, "orphans_b", c.orphansB);
    put(name, "fixes_a", c.fixesA);
    put(name, "fixes_b", c.fixesB);
  }
  return out;
}

/**
 * Pure (E5): one policy's calibration as tidy values: urls_*, inlink_*, depth_*, orphans_*,
 * and disagreements_<kind> (counts). Null values are left out.
 */
export function e5Metrics(c: PolicyCalibration): Metric[] {
  const out: Metric[] = [];
  const put = (metric: string, value: number | boolean | null) => {
    if (value === null) return;
    const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (Number.isFinite(v)) out.push({ metric, value: v });
  };
  put("urls_linklens", c.urls.linklens);
  put("urls_screaming_frog", c.urls.screamingFrog);
  put("urls_common", c.urls.common);
  put("url_jaccard", c.urls.jaccard);
  put("inlink_pages", c.inlinks.pages);
  put("inlink_spearman", c.inlinks.spearman);
  put("inlink_spearman_column", c.inlinks.spearmanColumn);
  put("inlink_large_differences", c.inlinks.largeDifferences);
  put("depth_pages", c.depth.pages);
  put("depth_exact", c.depth.exact);
  put("depth_within_one", c.depth.withinOne);
  put("depth_spearman", c.depth.spearman);
  put("depth_mean_abs_difference", c.depth.meanAbsDifference);
  put("depth_seed_differs", c.depth.seedDiffers);
  put("orphans_linklens", c.orphans.linklens);
  put("orphans_screaming_frog", c.orphans.screamingFrog);
  put("orphans_common", c.orphans.common);
  put("orphan_jaccard", c.orphans.jaccard);
  for (const kind of DISAGREEMENT_KINDS) {
    put(`disagreements_${kind}`, c.disagreements.filter((d) => d.kind === kind).length);
  }
  return out;
}

/** One E6 value of a repeat: a method ("masking" for the repeat itself), a metric, a value. */
export interface E6Metric {
  readonly repeat: number;
  readonly seed: number;
  readonly method: E6Method | "masking";
  readonly metric: string;
  readonly value: number;
}

/**
 * Pure (E6): every repeat as tidy values. "masking": share, eligible_pairs, masked, targets,
 * queries. Per method: recall@<k> for each k, mrr, auc (left out when undefined), queries.
 */
export function e6Metrics(r: E6Result): E6Metric[] {
  const out: E6Metric[] = [];
  for (const rep of r.repeats) {
    const put = (method: E6Metric["method"], metric: string, value: number | null) => {
      if (value !== null && Number.isFinite(value))
        out.push({ repeat: rep.repeat, seed: rep.seed, method, metric, value });
    };
    put("masking", "share", rep.share);
    put("masking", "eligible_pairs", rep.eligiblePairs);
    put("masking", "masked", rep.masked);
    put("masking", "targets", rep.targets);
    put("masking", "queries", rep.queries);
    for (const method of E6_METHODS) {
      const m = rep.methods[method];
      if (m === undefined) continue;
      for (const k of r.options.ks) put(method, `recall@${k}`, m.recall[k] ?? null);
      put(method, "mrr", m.mrr);
      put(method, "auc", m.auc);
      put(method, "queries", m.queries);
    }
  }
  return out;
}

export interface RunMetrics {
  readonly policies: PolicyMetrics[];
  /** E1: every pair of policies (15), a before b in P0–P5 order. */
  readonly pairs: stats.PolicyPairComparison[];
  /** The top k the fix lists were cut to. */
  readonly k: number;
  /** E2 under the audit's policy: each discovery channel removed in turn. */
  readonly channels: discovery.ChannelLeaveOneOut;
}

async function latest<P>(
  db: q.Queryable,
  runId: number,
  kind: string,
  policyVersion: string,
  keep: (p: P) => boolean = () => true,
): Promise<P | null> {
  const rows = await q.listArtefacts(db, runId, { kind, policyVersion });
  return (
    rows
      .map((r) => r.payload as unknown as P)
      .filter(keep)
      .at(-1) ?? null
  );
}

/**
 * The metrics of a stored, audited run under all six policies, and every pair of policies
 * compared (E1). Everything is derived in memory from the raw observations with the run's stored
 * config (nothing is written); fixes and rescue come from the artefacts the audit stored (the
 * audit's policy, and the others when the batch ranked every policy).
 */
export async function runMetrics(
  db: q.Queryable,
  runId: number,
  auditPolicy: PolicyId,
  sigma?: SigmaVariant,
  refVariant: semantic.RefVariant = "weighted",
): Promise<RunMetrics> {
  const { observations, context, config } = await graph.loadRunGraphInputs(db, runId);
  const s = sigma ?? config.sigmaVariant;
  const snapshots = await stats.loadPolicySnapshots(db, runId, config.fixTopK, s);
  const sensitivity = stats.sensitivityFromSnapshots(snapshots, auditPolicy);
  const out: PolicyMetrics[] = [];
  for (const policy of stats.POLICY_ORDER) {
    const version = canonicalise.POLICIES[policy].version;
    const derived = graph.deriveGraphFromObservations(observations, policy, context, config);
    const nodes: NodeMetrics[] = [];
    derived.graph.forEachNode((_n, attrs) => {
      nodes.push({
        crawled: attrs.crawled,
        reachable: attrs.reachable === true,
        depth: attrs.depth ?? null,
        pagerank: attrs.pagerank ?? 0,
      });
    });
    const [reconciliation, audit, { model }, prom, ranking, rescue] = await Promise.all([
      discovery.loadReconciliation(db, runId, policy),
      auditCore.loadAudit(db, runId, policy),
      text.loadTextModel(db, runId, policy),
      prominence.loadProminence(db, runId, policy),
      latest<fixes.FixRanking>(
        db,
        runId,
        fixes.FIX_RANKING_ARTEFACT,
        version,
        (r) => r.sigmaVariant === s,
      ),
      latest<{ orphans: fixes.RescuedOrphan[] }>(db, runId, fixes.RESCUE_ARTEFACT, version),
    ]);
    const ref = semantic.refMatrix(model, refVariant, config);
    const report = diagnosis.diagnose({ ref, prominence: prom }, config);
    const comparison = sensitivity.policies.find((c) => c.policy === policy);
    if (comparison === undefined) throw new Error(`no ${policy} comparison for run ${runId}`);
    out.push({
      policy,
      policyVersion: version,
      metrics: policyMetrics({
        graph: derived.summary,
        nodes,
        reconciliation,
        audit: audit.summary,
        diagnosis: report.counts,
        refEntries: ref.entries.length,
        comparison,
        ranking,
        rescue,
        k: config.fixTopK,
      }),
    });
  }
  const channels = discovery.leaveOneChannelOut(
    await discovery.loadReconcileInput(db, runId, auditPolicy),
  );
  return {
    policies: out,
    pairs: stats.comparePolicyPairs(snapshots).pairs,
    k: config.fixTopK,
    channels,
  };
}
