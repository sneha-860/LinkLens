import { describe, expect, it } from "vitest";
import { canonicalise, makeConfig, type db as q, type discovery } from "@linklens/core";
import { channelAblation } from "./e2-channels.js";
import { compareWithBaselines, type DonorOption } from "./e3-baselines.js";
import { calibrate, parseScreamingFrog } from "./e5-screaming-frog.js";
import { parseRatings, ratingSheet, summariseRatings } from "./e8-ratings.js";
import { hideAndRecover, type RecoveryInputs } from "./recovery.js";

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
describe("E3 fixes against baselines", () => {
  const opt = (
    target: string,
    donor: string,
    deltaPr: number,
    rest: Partial<DonorOption> = {},
  ): DonorOption => ({
    donor,
    target,
    ref: 0.3,
    sameSection: false,
    donorPagerank: 0.1,
    deltaPr,
    deltaDepth: -1,
    targetRank: 9,
    ...rest,
  });
  const options = [
    opt("t1", "home", 0.01, { donorPagerank: 0.5, targetRank: 3 }),
    opt("t1", "a", 0.04, { ref: 0.9, targetRank: 1, sameSection: true }),
    opt("t1", "b", 0.05, { ref: 0.2, targetRank: 2 }),
    opt("t2", "a", 0.02, { targetRank: 1, ref: 0.4 }),
    opt("t2", "c", 0.03, { ref: 0.8, donorPagerank: 0.3, targetRank: 2 }),
  ];
  const r = compareWithBaselines(options, "home", "refGateCosine", 42);
  const m = (name: string) => r.methods.find((x) => x.method === name);

  it("lets every method pick among the same donors and scores the picks", () => {
    expect(r.targets).toBe(2);
    expect(m("linklens")).toMatchObject({ targets: 2, linklensWinRate: null });
    expect(m("linklens")?.meanDeltaPr).toBeCloseTo(0.03, 12); // a (0.04), a (0.02)
    expect(m("oracle")?.meanDeltaPr).toBeCloseTo(0.04, 12); // b (0.05), c (0.03)
    expect(m("oracle")?.meanShareOfBest).toBe(1);
    expect(m("refOnly")?.meanRef).toBeCloseTo(0.85, 12); // a (0.9), c (0.8)
    expect(m("highestPagerank")?.meanDeltaPr).toBeCloseTo(0.02, 12); // home (0.01), c (0.03)
    expect(m("homePage")).toMatchObject({ targets: 1 }); // only admissible for t1
    expect(m("highestPagerank")?.linklensWinRate).toBe(0.5); // wins on t1, loses on t2
    expect(r.perTarget[0]).toMatchObject({
      target: "t1",
      picks: { linklens: { donor: "a", deltaPr: 0.04 }, oracle: { donor: "b", deltaPr: 0.05 } },
    });
    expect(r.perTarget[1]?.picks.homePage).toBeUndefined();
  });

  it("is deterministic for a seed", () => {
    expect(compareWithBaselines(options, "home", "refGateCosine", 42)).toEqual(r);
  });
});

// ---------- E5 ----------
describe("E5 Screaming Frog calibration", () => {
  const csv = [
    '"Internal - All"',
    "Address,Content Type,Status Code,Indexability,Crawl Depth,Unique Inlinks",
    `${S}/,text/html; charset=UTF-8,200,Indexable,0,5`,
    `${S}/a,text/html; charset=UTF-8,200,Indexable,1,3`,
    `${S}/b,text/html; charset=UTF-8,200,Indexable,3,1`,
    `${S}/c.pdf,application/pdf,200,Indexable,2,1`,
    `${S}/gone,text/html,404,Non-Indexable,2,1`,
    `${S}/only-sf,text/html,200,Indexable,4,1`,
  ].join("\n");
  const sf = parseScreamingFrog(csv);

  it("parses the export, skipping the title line, by column name", () => {
    expect(sf).toHaveLength(6);
    expect(sf[1]).toEqual({
      address: `${S}/a`,
      statusCode: 200,
      contentType: "text/html; charset=UTF-8",
      crawlDepth: 1,
      uniqueInlinks: 3,
      indexability: "Indexable",
    });
  });

  it("compares coverage, depth and inlinks on HTML 200 pages", () => {
    const ours = [
      { url: `${S}/`, depth: 0, inNeighbours: 4 },
      { url: `${S}/a`, depth: 1, inNeighbours: 3 },
      { url: `${S}/b`, depth: 2, inNeighbours: 1 },
      { url: `${S}/only-ours`, depth: 2, inNeighbours: 1 },
    ];
    const c = calibrate(ours, sf, (u) => u);
    expect(c).toMatchObject({
      ours: 4,
      screamingFrog: 4,
      common: 3,
      onlyOurs: [`${S}/only-ours`],
      onlyScreamingFrog: [`${S}/only-sf`],
    });
    expect(c.coverageJaccard).toBeCloseTo(3 / 5, 12);
    expect(c.depth).toMatchObject({ pages: 3, exact: 2 / 3, withinOne: 1 });
    expect(c.depth.spearman).toBeCloseTo(1, 12);
    expect(c.inlinksSpearman).toBeCloseTo(1, 12);
  });

  it("refuses a file that is not a Screaming Frog export", () => {
    expect(() => parseScreamingFrog("url,depth\n/a,1")).toThrow(/Address/);
  });
});

// ---------- E8 ----------
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
describe("E6/E7 hide-and-recover", () => {
  // A hub about whales, sharks and turtles links (main content) to each; each links home.
  const pagesDef: [string, string, string, string[]][] = [
    ["/", "Home", "Welcome to the ocean site.", ["/guides/"]],
    [
      "/guides/",
      "Ocean guides",
      "Whale songs. Shark teeth. Turtle nests.",
      ["/guides/whale", "/guides/shark", "/guides/turtle"],
    ],
    ["/guides/whale", "Whale songs", "Whale songs travel far.", ["/"]],
    ["/guides/shark", "Shark teeth", "Shark teeth grow back.", ["/"]],
    ["/guides/turtle", "Turtle nests", "Turtle nests on beaches.", ["/"]],
    ["/cakes/", "Cakes", "Chocolate cake recipes.", ["/"]],
  ];
  let id = 0;
  const pages = pagesDef.map(([path, title, body], i) => ({
    fetchId: i + 1,
    url: S + path,
    title,
    h1: title,
    bodyText: body,
  }));
  const linkRows: q.LinkObservationRow[] = pagesDef.flatMap(([, , , targets], i) =>
    targets.map((t, pos) => ({
      id: ++id,
      runId: 1,
      sourceFetchId: i + 1,
      rawHref: t,
      resolvedUrl: S + t,
      anchorText: t.split("/").filter(Boolean).pop() ?? "home",
      rel: null,
      domRegion: t === "/" ? "nav" : "main", // links home are navigation
      domPath: `main>a:nth-of-type(${pos + 1})`,
      templateSignature: "block",
      positionIndex: pos,
    })),
  );
  const inputs: RecoveryInputs = {
    runId: 1,
    policyId: "P0",
    config: makeConfig({ frequentNgramDropPct: 0 }),
    observations: {
      runId: 1,
      seedUrl: `${S}/`,
      pages: pages.map((p) => ({ fetchId: p.fetchId, url: p.url })),
      links: linkRows.map((l) => ({
        id: l.id,
        sourceFetchId: l.sourceFetchId,
        resolvedUrl: l.resolvedUrl as string,
        domRegion: l.domRegion,
        anchorText: l.anchorText,
        templateSignature: l.templateSignature,
        rel: l.rel,
      })),
    },
    context: canonicalise.EMPTY_CONTEXT,
    pages,
    linkRows,
    cosine: null,
  };

  it("hides a sample of main-content links and finds where each donor ranks again (E6)", () => {
    const r = hideAndRecover(inputs, {
      sample: 2,
      seed: 7,
      sigmas: ["refOnly"],
      ks: [1, 3],
      requireRef: true,
    });
    expect(r.hidden).toHaveLength(2);
    for (const h of r.hidden) expect(h.donor).not.toBe(h.target);
    const ranks = r.bySigma["refOnly"]?.ranks ?? [];
    expect(ranks).toHaveLength(2);
    // The hub covers the animal pages' topics: when its link to one is hidden, it comes back first.
    const hubRanks = r.hidden
      .map((h, i) => (h.donor === `${S}/guides/` ? ranks[i] : undefined))
      .filter((x) => x !== undefined);
    for (const rank of hubRanks) expect(rank).toBe(1);
    expect(r.candidateRecall).toBeGreaterThan(0);
    expect(
      hideAndRecover(inputs, {
        sample: 2,
        seed: 7,
        sigmas: ["refOnly"],
        ks: [1, 3],
        requireRef: true,
      }),
    ).toEqual(r);
  });

  it("compares every σ on the same pool without the REF filter (E7)", () => {
    const r = hideAndRecover(inputs, {
      sample: 3,
      seed: 1,
      sigmas: ["refGateCosine", "cosineOnly", "refOnly", "blended"],
      ks: [1, 5],
      requireRef: false,
    });
    expect(Object.keys(r.bySigma).sort()).toEqual([
      "blended",
      "cosineOnly",
      "refGateCosine",
      "refOnly",
    ]);
    expect(r.sigmaAgreement).toHaveLength(6);
    for (const m of Object.values(r.bySigma)) {
      expect(m.recall[5]).toBeGreaterThanOrEqual(m.recall[1] as number);
    }
    // Without the REF filter, every hidden donor is a candidate again.
    expect(r.candidateRecall).toBe(1);
  });
});
