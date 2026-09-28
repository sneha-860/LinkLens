import { describe, expect, it } from "vitest";
import { discovery, type audit, type graph, type stats } from "@linklens/core";
import type { E3Method } from "../e3-baselines.js";
import type { Comparison, Stability } from "../e4-stability.js";
import type { PolicyCalibration } from "../e5-screaming-frog.js";
import type { E6Result } from "../e6-masking.js";
import type { E7Result } from "../e7-ablation.js";
import {
  PAIR_METRICS,
  e7Metrics,
  e6Metrics,
  e5Metrics,
  e4Metrics,
  e3Metrics,
  channelMetrics,
  gini,
  pairMetrics,
  policyMetrics,
  type PolicyInputs,
} from "./metrics.js";

describe("gini", () => {
  it("is 0 for equal values and grows with concentration", () => {
    expect(gini([1, 1, 1, 1])).toBe(0);
    expect(gini([0, 0, 0, 1])).toBeCloseTo(0.75);
    expect(gini([3, 1, 2])).toBeCloseTo(gini([1, 2, 3]) as number); // order-free
    expect(gini([])).toBeNull();
    expect(gini([0, 0])).toBeNull();
  });
});

const channels = Object.fromEntries(
  discovery.DISCOVERY_CHANNELS.map((c) => [c, { total: 0, exclusive: 0, orphans: 0 }]),
) as PolicyInputs["reconciliation"]["channels"];

function inputs(over: Partial<PolicyInputs> = {}): PolicyInputs {
  return {
    graph: {
      nodes: 4,
      edges: 6,
      weightedEdges: 5,
      selfLoops: 1,
      externalLinks: 2,
      duplicatePageLinks: 0,
      reachable: 3,
      sccCount: 2,
      largestSccSize: 3,
      pagerank: { iterations: 12, converged: true, damping: 0.85 },
    } as graph.GraphSummary,
    nodes: [
      { crawled: true, reachable: true, depth: 0, pagerank: 0.4 },
      { crawled: true, reachable: true, depth: 1, pagerank: 0.3 },
      { crawled: true, reachable: true, depth: 2, pagerank: 0.2 },
      { crawled: false, reachable: false, depth: null, pagerank: 0.1 },
    ],
    reconciliation: {
      inventory: [{}, {}, {}, {}, {}] as PolicyInputs["reconciliation"]["inventory"],
      orphans: ["x"],
      channels: { ...channels, xml_sitemap: { total: 4, exclusive: 1, orphans: 1 } },
    },
    audit: {
      total: 5,
      nodesWithIssues: 2,
      pagesAudited: 3,
      byType: { orphan: 1, "deep-page": 0 },
      bySeverity: { high: 1, medium: 3, low: 1 },
      byRule: { "internal-nofollow": 2, "noindex-in-sitemap": 0 },
      thresholds: { weakAuthorityThreshold: 0.21 },
    } as unknown as audit.AuditSummary,
    diagnosis: { v4: 2, v3: 1, v2: 1, v1: 0, unclassified: 3, skippedNoText: 1, pairs: 7 },
    refEntries: 9,
    comparison: {
      pagerankSpearman: 1,
      meanDepthShift: 0,
      meanAbsDepthShift: 0,
      topFixesJaccard: null,
    } as stats.PolicyComparison,
    ranking: null,
    rescue: null,
    k: 2,
    ...over,
  };
}

const asMap = (p: PolicyInputs) => new Map(policyMetrics(p).map((m) => [m.metric, m.value]));

describe("policyMetrics", () => {
  it("derives graph, discovery, audit, diagnosis and sensitivity metrics", () => {
    const m = asMap(inputs());
    expect(m.get("graph.nodes")).toBe(4);
    expect(m.get("graph.crawled_pages")).toBe(3);
    expect(m.get("graph.edges_per_crawled_page")).toBe(2);
    expect(m.get("graph.reachable_share")).toBe(0.75);
    expect(m.get("graph.mean_depth")).toBe(1);
    expect(m.get("graph.median_depth")).toBe(1);
    expect(m.get("graph.max_depth")).toBe(2);
    expect(m.get("graph.pagerank_converged")).toBe(1);
    expect(m.get("graph.pagerank_gini")).toBeCloseTo(0.25);
    expect(m.get("discovery.orphan_share")).toBe(0.2);
    expect(m.get("discovery.xml_sitemap.exclusive")).toBe(1);
    expect(m.get("discovery.feed.total")).toBe(0);
    expect(m.get("audit.type.orphan")).toBe(1);
    expect(m.get("audit.rule.internal-nofollow")).toBe(2);
    expect(m.get("audit.weak_authority_threshold")).toBe(0.21);
    expect(m.get("diagnosis.v4")).toBe(2);
    expect(m.get("diagnosis.v4_share")).toBe(0.5);
    expect(m.get("ref.entries")).toBe(9);
    expect(m.get("sensitivity.pagerank_spearman")).toBe(1);
  });

  it("leaves out metrics without a value, never writing 0 for them", () => {
    const m = asMap(
      inputs({
        nodes: [],
        reconciliation: { inventory: [], orphans: [], channels },
      }),
    );
    expect(m.has("graph.mean_depth")).toBe(false);
    expect(m.has("graph.pagerank_gini")).toBe(false);
    expect(m.has("discovery.orphan_share")).toBe(false);
    expect(m.has("sensitivity.top_fixes_jaccard")).toBe(false);
    expect([...m.keys()].some((k) => k.startsWith("fixes.") || k.startsWith("rescue."))).toBe(
      false,
    );
  });

  it("summarises the top-k fixes and the rescue when they exist", () => {
    const fix = (o: object) => ({
      type: "add-link",
      deltaPr: 0.01,
      score: 0.005,
      kappa: 1,
      depthBefore: 3,
      depthAfter: 2,
      deltaDepth: -1,
      ...o,
    });
    const m = asMap(
      inputs({
        ranking: {
          counts: { fixes: 3, targets: 2 },
          fixes: [
            fix({}),
            fix({
              type: "make-visible",
              deltaPr: 0.03,
              kappa: 3,
              depthBefore: null,
              depthAfter: 1,
              deltaDepth: null,
            }),
            fix({ deltaPr: 9 }), // beyond k = 2
          ] as unknown as NonNullable<PolicyInputs["ranking"]>["fixes"],
        },
        rescue: {
          orphans: [
            { status: "scored", donors: [{}] },
            { status: "no-text", donors: [] },
          ] as unknown as NonNullable<PolicyInputs["rescue"]>["orphans"],
        },
      }),
    );
    expect(m.get("fixes.count")).toBe(3);
    expect(m.get("fixes.add_link_share")).toBeCloseTo(2 / 3);
    expect(m.get("fixes.top_k")).toBe(2);
    expect(m.get("fixes.top_k_mean_delta_pr")).toBeCloseTo(0.02);
    expect(m.get("fixes.top_k_mean_kappa")).toBe(2);
    expect(m.get("fixes.top_k_newly_reachable")).toBe(1);
    expect(m.get("fixes.top_k_mean_depth_gain")).toBe(1);
    expect(m.get("rescue.with_donor")).toBe(1);
    expect(m.get("rescue.with_donor_share")).toBe(0.5);
  });

  it("names are unique and the order is fixed", () => {
    const names = policyMetrics(inputs()).map((m) => m.metric);
    expect(new Set(names).size).toBe(names.length);
    expect(policyMetrics(inputs()).map((m) => m.metric)).toEqual(names);
  });
});

describe("pairMetrics", () => {
  const pair: stats.PolicyPairComparison = {
    a: "P2",
    b: "P3",
    nodesA: 10,
    nodesB: 8,
    nodeDelta: -2,
    nodeRatio: 0.8,
    sharedNodes: 8,
    nodeJaccard: 0.8,
    orphansA: 1,
    orphansB: 1,
    orphanJaccard: 1,
    pagerankSpearman: 0.9,
    depthPages: 7,
    meanDepthShift: -0.25,
    meanAbsDepthShift: 0.5,
    maxAbsDepthShift: 2,
    topFixesJaccard: null,
  };

  it("names every pair metric once, in a fixed order, and leaves nulls out", () => {
    const m = pairMetrics(pair);
    expect(m.map((x) => x.metric)).toEqual(
      PAIR_METRICS.map(([name]) => name).filter((n) => n !== "top_fixes_jaccard"),
    );
    expect(Object.fromEntries(m.map((x) => [x.metric, x.value]))).toMatchObject({
      node_delta: -2,
      node_ratio: 0.8,
      orphan_jaccard: 1,
      pagerank_spearman: 0.9,
      mean_depth_shift: -0.25,
      max_abs_depth_shift: 2,
    });
    expect(pairMetrics({ ...pair, topFixesJaccard: 0.5 }).at(-1)).toEqual({
      metric: "top_fixes_jaccard",
      value: 0.5,
    });
  });
});

describe("channelMetrics", () => {
  const removal = (channel: discovery.DiscoveryChannel, lost: number) => ({
    channel,
    pagesTotal: 5,
    pagesExclusive: 1,
    orphansTotal: lost + 1,
    orphansExclusive: lost,
    orphansExclusiveShare: lost / 4,
    inventoryWithout: 9,
    orphansWithout: 4 - lost,
    lostOrphans: [],
  });

  it("writes the site totals, then seven values per channel", () => {
    const m = channelMetrics({
      runId: 1,
      policyVersion: "P3@1.0.0",
      inventory: 10,
      orphans: 4,
      orphansBy: {
        only: {
          link_graph: 0,
          xml_sitemap: 3,
          robots_sitemap: 0,
          html_sitemap: 0,
          feed: 0,
          llms_txt: 0,
        },
        several: 1,
      },
      removals: [removal("link_graph", 0), removal("xml_sitemap", 3)],
    });
    expect(m.slice(0, 3)).toEqual([
      { channel: "all", metric: "inventory", value: 10 },
      { channel: "all", metric: "orphans", value: 4 },
      { channel: "all", metric: "orphans_several_channels", value: 1 },
    ]);
    expect(m.filter((x) => x.channel === "xml_sitemap").map((x) => [x.metric, x.value])).toEqual([
      ["pages_total", 5],
      ["pages_exclusive", 1],
      ["orphans_total", 4],
      ["orphans_exclusive", 3],
      ["orphans_exclusive_share", 0.75],
      ["inventory_without", 9],
      ["orphans_without", 1],
    ]);
  });

  it("leaves the share out when a site has no orphans", () => {
    const m = channelMetrics({
      runId: 1,
      policyVersion: "P3@1.0.0",
      inventory: 3,
      orphans: 0,
      orphansBy: {
        only: {
          link_graph: 0,
          xml_sitemap: 0,
          robots_sitemap: 0,
          html_sitemap: 0,
          feed: 0,
          llms_txt: 0,
        },
        several: 0,
      },
      removals: [{ ...removal("feed", 0), orphansExclusiveShare: null }],
    });
    expect(m.some((x) => x.metric === "orphans_exclusive_share")).toBe(false);
  });
});

describe("e3Metrics", () => {
  const outcome = (method: E3Method, total: number, sd: number | null) => ({
    method,
    selected: 2,
    targetsCovered: 2,
    totalDeltaPr: total,
    totalDeltaPrSd: sd,
    sumSingleDeltaPr: total * 1.1,
    deltaPrL1: 0.01,
    newlyReachable: 1,
    meanRef: 0.4,
    meanCosine: null,
    fixes: null,
  });

  it("writes the site values once, then each k × method, leaving nulls out", () => {
    const m = e3Metrics({
      sigma: "refGateCosine",
      seed: 42,
      randomDraws: 20,
      ks: [10],
      targets: { weak: 3, orphan: 1, total: 4 },
      pool: {
        pairs: 9,
        weakPairs: 7,
        orphanPairs: 2,
        weakTargetsWithDonors: 3,
        orphanTargetsWithDonors: 1,
      },
      targetPagerankBefore: 0.05,
      byK: [
        { k: 10, methods: [outcome("linklens", 0.004, null), outcome("random", 0.001, 0.0005)] },
      ],
    });
    expect(m.filter((x) => x.method === "site").map((x) => [x.k, x.metric, x.value])).toEqual([
      [null, "targets_weak", 3],
      [null, "targets_orphan", 1],
      [null, "pool_pairs", 9],
      [null, "pool_weak_pairs", 7],
      [null, "pool_orphan_pairs", 2],
      [null, "weak_targets_with_donors", 3],
      [null, "orphan_targets_with_donors", 1],
      [null, "target_pagerank_before", 0.05],
    ]);
    const ours = m.filter((x) => x.method === "linklens");
    expect(ours[0]).toEqual({ k: 10, method: "linklens", metric: "total_delta_pr", value: 0.004 });
    expect(ours.some((x) => x.metric === "total_delta_pr_sd" || x.metric === "mean_cosine")).toBe(
      false,
    );
    expect(m.find((x) => x.method === "random" && x.metric === "total_delta_pr_sd")?.value).toBe(
      0.0005,
    );
  });
});

describe("e4Metrics", () => {
  const cmp = (j: number, rho: number | null): Comparison => ({
    crawledA: 10,
    crawledB: 9,
    nodeJaccard: j,
    pagerankSpearman: rho,
    sharedNodes: 9,
    orphansA: 1,
    orphansB: 1,
    orphanJaccard: 1,
    topFixesJaccard: 0.8,
    fixesA: 20,
    fixesB: 18,
  });

  it("writes the page classes, then eleven values per comparison, nulls left out", () => {
    const s: Stability = {
      runA: 1,
      runB: 2,
      daysApart: 14,
      policyVersion: "P3@1.0.0",
      k: 10,
      pages: {
        union: 11,
        unchanged: 8,
        changed: 1,
        site: { gone: 1, redirect: 0, "not-html": 0, robots: 0, link: 0 },
        method: { "not-admitted": 1, failed: 0 },
        onlyA: 2,
        onlyB: 0,
      },
      siteChangeShare: 2 / 11,
      methodShare: 1 / 11,
      discoveryDocuments: { unchanged: 3, changed: 1, onlyA: 0, onlyB: 0 },
      comparisons: {
        observed: cmp(0.8, 0.9),
        siteChange: cmp(0.9, 0.95),
        samePages: cmp(1, null),
        coverageA: cmp(0.9, 0.99),
        coverageB: cmp(1, 1),
      },
      classes: [],
    };
    const m = e4Metrics(s);
    const pages = new Map(
      m.filter((x) => x.comparison === "pages").map((x) => [x.metric, x.value]),
    );
    expect(pages.get("days_apart")).toBe(14);
    expect(pages.get("site_gone")).toBe(1);
    expect(pages.get("method_not-admitted")).toBe(1);
    expect(pages.get("docs_changed")).toBe(1);
    expect(m.filter((x) => x.comparison === "observed")).toHaveLength(11);
    expect(m.filter((x) => x.comparison === "samePages")).toHaveLength(10); // no Spearman
    expect(m.find((x) => x.comparison === "siteChange" && x.metric === "node_jaccard")?.value).toBe(
      0.9,
    );
  });
});

describe("e5Metrics", () => {
  it("writes each measure and the disagreement counts per kind, nulls left out", () => {
    const c: PolicyCalibration = {
      policy: "P3",
      policyVersion: "P3@1.0.0",
      urls: { linklens: 10, screamingFrog: 12, common: 9, jaccard: 9 / 13 },
      inlinks: { pages: 9, spearman: 0.8, spearmanColumn: 0.7, largeDifferences: 1 },
      depth: {
        pages: 9,
        exact: 0.5,
        withinOne: 1,
        spearman: 0.9,
        meanAbsDifference: 0.6,
        seedDiffers: false,
      },
      orphans: { linklens: 2, screamingFrog: null, common: null, jaccard: null },
      categories: [],
      disagreements: [
        { kind: "depth", node: "n", category: "cascade", detail: {} },
        { kind: "depth", node: "m", category: "other", detail: {} },
      ],
    };
    const m = new Map(e5Metrics(c).map((x) => [x.metric, x.value]));
    expect(m.get("url_jaccard")).toBeCloseTo(9 / 13);
    expect(m.get("depth_seed_differs")).toBe(0);
    expect(m.get("disagreements_depth")).toBe(2);
    expect(m.get("disagreements_inlinks")).toBe(0);
    expect(m.has("orphan_jaccard")).toBe(false);
  });
});

describe("e6Metrics", () => {
  it("writes each repeat's masking, then recall@k, MRR, AUC and queries per method", () => {
    const r = {
      runId: 1,
      policyVersion: "P3@1.0.0",
      options: { ks: [5, 10] },
      repeats: [
        {
          repeat: 0,
          seed: 42,
          share: 0.15,
          eligiblePairs: 40,
          masked: 6,
          targets: 5,
          queries: 6,
          methods: {
            cosine: { queries: 6, recall: { 5: 0.5, 10: 0.8 }, mrr: 0.4, auc: 0.9 },
            random: { queries: 6, recall: { 5: 0.1, 10: 0.2 }, mrr: 0.05, auc: null },
          },
        },
      ],
      summary: {},
    } as unknown as E6Result;
    const m = e6Metrics(r);
    expect(m.filter((x) => x.method === "masking").map((x) => [x.metric, x.value])).toEqual([
      ["share", 0.15],
      ["eligible_pairs", 40],
      ["masked", 6],
      ["targets", 5],
      ["queries", 6],
    ]);
    expect(m.filter((x) => x.method === "cosine").map((x) => x.metric)).toEqual([
      "recall@5",
      "recall@10",
      "mrr",
      "auc",
      "queries",
    ]);
    expect(m.some((x) => x.method === "random" && x.metric === "auc")).toBe(false);
    expect(m.every((x) => x.repeat === 0 && x.seed === 42)).toBe(true);
  });
});

describe("e7Metrics", () => {
  it("writes each setting's ranking, E3 gain and E6 recovery", () => {
    const r = {
      e3Ks: [10],
      rows: [
        {
          sigma: "refGateCosine",
          epsilon: 0.2,
          alpha: 0.1,
          isDefault: true,
          sweeps: ["sigma", "epsilon", "alpha"],
          fixes: 40,
          topKJaccardDefault: 1,
          e3: { pool: 12, linklens: { 10: 0.03 }, random: { 10: 0.01 } },
          e6: { queries: 20, recall: { 5: 0.5, 10: 0.7 }, mrr: 0.4, auc: 0.9 },
        },
        {
          sigma: "cosineOnly",
          epsilon: 0.3,
          alpha: 0.1,
          isDefault: false,
          sweeps: ["epsilon"],
          fixes: 30,
          topKJaccardDefault: 0.5,
          e3: { pool: 8, linklens: { 10: 0.02 }, random: { 10: 0.01 } },
          e6: null,
        },
      ],
    } as unknown as E7Result;
    const m = e7Metrics(r);
    const def = new Map(m.filter((x) => x.isDefault).map((x) => [x.metric, x.value]));
    expect([...def.keys()]).toEqual([
      "fixes",
      "topk_jaccard_default",
      "e3_pool",
      "e3_linklens@10",
      "e3_random@10",
      "e3_gain@10",
      "e6_mrr",
      "e6_recall@5",
      "e6_recall@10",
      "e6_auc",
    ]);
    expect(def.get("e3_gain@10")).toBeCloseTo(0.02);
    expect(m.find((x) => x.isDefault)?.sweeps).toBe("sigma|epsilon|alpha");
    expect(m.filter((x) => x.sigma === "cosineOnly").some((x) => x.metric.startsWith("e6_"))).toBe(
      false,
    );
  });
});
