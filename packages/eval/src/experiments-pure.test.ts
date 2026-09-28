import { describe, expect, it } from "vitest";
import { fixes, makeConfig, type discovery } from "@linklens/core";
import { channelAblation } from "./e2-channels.js";
import {
  compareE3,
  evaluateSelection,
  rankPool,
  type E3Inputs,
  type PoolEntry,
} from "./e3-baselines.js";
import { parseRatings, ratingSheet, summariseRatings } from "./e8-ratings.js";

const S = "https://s.test";

// ---------- E2 ----------
describe("E2 channel ablation", () => {
  const entry = (node: string, channels: discovery.DiscoveryChannel[], orphan: boolean) => ({
    node,
    channels,
    sources: {},
    urls: [],
    reachable: !orphan,
    depth: orphan ? null : 1,
    orphan,
  });
  const rec = {
    inventory: [
      entry("a", ["link_graph", "xml_sitemap"], false),
      entry("o1", ["xml_sitemap", "feed"], true),
      entry("o2", ["llms_txt"], true),
      entry("o3", ["html_sitemap"], true),
    ],
  };
  const r = channelAblation(rec);

  it("finds every orphan with all channels and none with none", () => {
    expect(r.subsets).toHaveLength(32);
    expect(r.subsets[0]).toMatchObject({ orphansFound: 3, orphanRecall: 1, pagesKnown: 4 });
    expect(r.subsets.find((s) => s.channels.length === 0)).toMatchObject({
      orphansFound: 0,
      pagesKnown: 1,
    });
  });

  it("measures each channel alone and what dropping it costs", () => {
    const single = Object.fromEntries(r.single.map((s) => [s.channels[0], s.orphansFound]));
    expect(single).toEqual({
      xml_sitemap: 1,
      robots_sitemap: 0,
      html_sitemap: 1,
      feed: 1,
      llms_txt: 1,
    });
    const lost = Object.fromEntries(r.leaveOneOut.map((s) => [s.removed, s.orphansLost]));
    // o1 is also in the feed, so dropping the XML sitemap loses nothing.
    expect(lost).toEqual({
      xml_sitemap: 0,
      robots_sitemap: 0,
      html_sitemap: 1,
      feed: 0,
      llms_txt: 1,
    });
  });
});

// ---------- E3 ----------
describe("E3 top-k fixes against baselines, applied together", () => {
  // h (home) → a, b; a → h, w; b → h. w is weak (one inlink), o is an orphan (no inlink).
  const g = fixes.weightedGraph(["a", "b", "h", "o", "w"], "h", [
    { source: "h", target: "a", weight: 1 },
    { source: "h", target: "b", weight: 1 },
    { source: "a", target: "h", weight: 1 },
    { source: "a", target: "w", weight: 0.1 },
    { source: "b", target: "h", weight: 1 },
  ]);
  const params = makeConfig();
  const base = fixes.baseline(g, params);
  const entry = (donor: string, target: string, o: Partial<PoolEntry> = {}): PoolEntry => ({
    id: `add-link:${donor}->${target}`,
    donor,
    target,
    kind: target === "o" ? "orphan" : "weak",
    action: "add-link",
    ref: 0.5,
    cosine: 0.5,
    donorPagerank: base.rank[g.nodes.indexOf(donor)] as number,
    deltaPr: 0,
    kappa: 1,
    score: 0,
    ...o,
  });
  const pool: PoolEntry[] = [
    entry("a", "o", { score: 3, cosine: 0.2 }),
    entry("b", "w", { score: 2, cosine: 0.9 }),
    entry("h", "w", { score: 1, cosine: null }),
    entry("b", "o", { score: 1, deltaPr: 0.5, cosine: 0.1 }),
  ];
  const inputs: E3Inputs = {
    graph: g,
    base,
    bodyWeight: 1,
    params,
    targets: [
      { node: "w", kind: "weak" },
      { node: "o", kind: "orphan" },
    ],
    pool,
    sigma: "refGateCosine",
  };

  it("ranks the pool by each method's own criterion", () => {
    const ids = (m: Parameters<typeof rankPool>[1]) => rankPool(pool, m).map((e) => e.id);
    expect(ids("linklens")).toEqual([
      "add-link:a->o",
      "add-link:b->w",
      "add-link:b->o", // score tie with h->w: the larger ΔPR first
      "add-link:h->w",
    ]);
    expect(ids("highestCosine")).toEqual([
      "add-link:b->w",
      "add-link:a->o",
      "add-link:b->o",
      "add-link:h->w", // no cosine: last
    ]);
    // The home page has the highest PageRank.
    expect(ids("highestPagerank")[0]).toBe("add-link:h->w");
  });

  it("applies the fixes together and sums ΔPR over the weak and orphan pages", () => {
    const one = evaluateSelection(inputs, [pool[0] as PoolEntry]);
    const wIndex = g.nodes.indexOf("w");
    const oIndex = g.nodes.indexOf("o");
    const joint = fixes.applyLinks(
      g,
      base,
      [{ donor: g.nodes.indexOf("a"), target: oIndex }],
      1,
      params,
    );
    expect(one.totalDeltaPr).toBeCloseTo(
      (joint.rank[oIndex] as number) -
        (base.rank[oIndex] as number) +
        (joint.rank[wIndex] as number) -
        (base.rank[wIndex] as number),
      12,
    );
    expect(one).toMatchObject({ selected: 1, targetsCovered: 1, newlyReachable: 1, meanRef: 0.5 });
    const two = evaluateSelection(inputs, [pool[0] as PoolEntry, pool[3] as PoolEntry]);
    expect(two.targetsCovered).toBe(1); // both to o
    expect(two.totalDeltaPr).toBeGreaterThan(one.totalDeltaPr);
    expect(two.meanCosine).toBeCloseTo(0.15);
  });

  it("compares every method for every k, the random baseline as a seeded mean", () => {
    const r = compareE3(inputs, [2, 1], 5, 42);
    expect(r.ks).toEqual([1, 2]);
    expect(r.targets).toEqual({ weak: 1, orphan: 1, total: 2 });
    expect(r.pool).toEqual({
      pairs: 4,
      weakPairs: 2,
      orphanPairs: 2,
      weakTargetsWithDonors: 1,
      orphanTargetsWithDonors: 1,
    });
    const k2 = r.byK.find((b) => b.k === 2)?.methods ?? [];
    expect(k2.map((m) => m.method)).toEqual([
      "linklens",
      "random",
      "highestCosine",
      "highestPagerank",
    ]);
    expect(k2[0]?.fixes).toEqual(["add-link:a->o", "add-link:b->w"]);
    expect(k2[1]).toMatchObject({ method: "random", selected: 2, fixes: null });
    expect(k2[1]?.totalDeltaPrSd).toBeGreaterThanOrEqual(0);
    expect(k2[0]?.totalDeltaPrSd).toBeNull();
    // Deterministic for a seed, and each k has its own stream.
    expect(compareE3(inputs, [2, 1], 5, 42)).toEqual(r);
    expect(compareE3(inputs, [2], 5, 42).byK[0]).toEqual(r.byK[1]);
    expect(compareE3(inputs, [2], 5, 7).byK[0]?.methods[1]).not.toEqual(k2[1]);
  });

  it("with k at least the pool, every method applies the whole pool", () => {
    const all = compareE3(inputs, [10], 3, 1).byK[0]?.methods ?? [];
    const totals = all.map((m) => m.totalDeltaPr);
    for (const t of totals) expect(t).toBeCloseTo(totals[0] as number, 9);
    expect(all.every((m) => m.selected === 4)).toBe(true);
    expect(all[1]?.totalDeltaPrSd).toBeCloseTo(0, 9);
  });
});

describe("E8 human rating", () => {
  const items = [1, 2, 3].map((rank) => ({
    id: `f${rank}`,
    rank,
    donor: `${S}/d${rank}`,
    target: `${S}/t${rank}`,
    type: "add-link",
    score: 1 / rank,
    explanation: rank === 1 ? 'Add a link, "because"' : "Add a link",
  }));

  it("writes a sheet to fill, one row per fix in rank order", () => {
    const sheet = ratingSheet([...items].reverse());
    const lines = sheet.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "item_id,rank,donor,target,type,score,explanation,rater,relevance,would_add",
    );
    expect(lines[1]).toContain('"Add a link, ""because"""');
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["f1", "f2", "f3"]);
  });

  it("summarises filled sheets: means, top-10 vs rest, score vs relevance, agreement", () => {
    const header = "item_id,rank,donor,target,type,score,explanation,rater,relevance,would_add";
    const row = (
      id: string,
      rank: number,
      score: number,
      rater: string,
      rel: number,
      add: string,
    ) => [id, rank, "d", "t", "add-link", score, "x", rater, rel, add].join(",");
    const csv = [
      header,
      row("f1", 1, 1, "ana", 5, "yes"),
      row("f2", 2, 0.5, "ana", 3, "no"),
      row("f3", 12, 0.1, "ana", 1, "no"),
      row("f1", 1, 1, "ben", 5, "yes"),
      row("f2", 2, 0.5, "ben", 4, "yes"),
      row("f3", 12, 0.1, "ben", 2, ""),
    ].join("\n");
    const s = summariseRatings(parseRatings(csv));
    expect(s).toMatchObject({ ratings: 6, items: 3, raters: ["ana", "ben"], wouldAddRate: 3 / 5 });
    expect(s.meanRelevance).toBeCloseTo(20 / 6, 12);
    expect(s.meanRelevanceTop10).toBeCloseTo((5 + 3.5) / 2, 12);
    expect(s.meanRelevanceRest).toBeCloseTo(1.5, 12);
    expect(s.scoreVsRelevance).toBeCloseTo(1, 12);
    expect(s.interRater).toMatchObject({ pairs: 1, exactAgreement: 1 / 3 });
    expect(s.interRater.spearman).toBeCloseTo(1, 12);
  });

  it("rejects a relevance outside 1–5", () => {
    expect(() => parseRatings("item_id,rater,relevance\nf1,ana,7")).toThrow(/1–5/);
  });
});

// ---------- E6 / E7 ----------
