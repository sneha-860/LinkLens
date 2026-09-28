import { describe, expect, it } from "vitest";
import { makeConfig, prominence } from "@linklens/core";
import {
  SearchConsoleCsvError,
  bootstrap,
  linkLevel,
  pageLevel,
  pageTable,
  parseSearchConsoleCsv,
  proxyMarkdown,
  proxyParams,
  sourceLinks,
  spearmanOf,
} from "./proxy-validation.js";

const S = "https://s.test";
const config = makeConfig({ proxyBootstrap: 200, proxyMinEdgesPerSource: 3 });

describe("statistics", () => {
  it("computes Spearman on arrays, with ties and no variation", () => {
    expect(spearmanOf([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearmanOf([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(spearmanOf([1, 1, 2], [1, 2, 3])).toBeCloseTo(0.866, 3);
    expect(spearmanOf([1, 1], [1, 2])).toBeNull();
    expect(spearmanOf([1], [1])).toBeNull();
  });

  it("bootstraps a seeded interval around the statistic", () => {
    const units = Array.from({ length: 40 }, (_, i) => i);
    const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const a = bootstrap(units, mean, 300, 7);
    expect(a.value).toBe(19.5);
    expect(a.lo as number).toBeLessThan(19.5);
    expect(a.hi as number).toBeGreaterThan(19.5);
    expect(bootstrap(units, mean, 300, 7)).toEqual(a);
    expect(bootstrap([], mean, 300, 7)).toMatchObject({ lo: null, hi: null, n: 0 });
  });
});

// Three sources with four links each; ω matches the clicks' order on s1 and s2, not on s3.
const edge = (s: string, t: string, omega: number, observations = 1) => ({
  source: `${S}/${s}`,
  target: `${S}/${t}`,
  omega,
  observations,
  structuralWeight: omega,
});
const edges = [
  edge("s1", "a", 0.5, 1),
  edge("s1", "b", 0.3, 1),
  edge("s1", "c", 0.15, 1),
  edge("s1", "d", 0.05, 1),
  edge("s2", "a", 0.4, 2),
  edge("s2", "b", 0.3, 1),
  edge("s2", "c", 0.2, 1),
  edge("s2", "d", 0.1, 1),
  edge("s3", "a", 0.1, 3),
  edge("s3", "b", 0.2, 1),
  edge("s3", "c", 0.3, 1),
  edge("s3", "d", 0.4, 1),
  edge("quiet", "a", 1, 1),
];
const click = (
  s: string | null,
  t: string | null,
  clicks: number,
  reason?: "external" | "invalid-url",
): prominence.NodeClicks => ({
  source: s === null ? null : `${S}/${s}`,
  target: t === null ? null : `${S}/${t}`,
  clicks,
  ...(reason === undefined ? {} : { reason }),
});
const clicks = [
  click("s1", "a", 50),
  click("s1", "b", 30),
  click("s1", "c", 15),
  click("s1", "d", 5),
  click("s2", "a", 40),
  click("s2", "b", 30),
  click("s2", "c", 20),
  click("s3", "a", 40),
  click("s3", "b", 30),
  click("s3", "c", 20),
  click("s3", "d", 10),
  click("s1", "zzz", 9), // no such link
  click("s1", "s1", 3), // self-loop
  click(null, "a", 2, "external"),
  click(null, null, 1, "invalid-url"),
];

describe("link level", () => {
  const table = sourceLinks(edges, clicks);

  it("accounts for every click row and builds click shares per source", () => {
    expect(table.rows).toEqual({
      total: 15,
      used: 11,
      invalidUrl: 1,
      external: 1,
      selfLoop: 1,
      noLink: 1,
    });
    // "quiet" has no clicks: not a source here.
    expect(table.sources.map((s) => s.source)).toEqual([`${S}/s1`, `${S}/s2`, `${S}/s3`]);
    const s2 = table.sources[1];
    expect(s2?.links.find((l) => l.target === `${S}/d`)?.clickShare).toBe(0);
    expect(s2?.links.find((l) => l.target === `${S}/a`)?.countShare).toBe(0.4);
    for (const s of table.sources)
      expect(s.links.reduce((a, l) => a + l.clickShare, 0)).toBeCloseTo(1, 12);
  });

  it("correlates ω with click share, against the link-count baseline", () => {
    const r = linkLevel(table, config);
    expect(r).toMatchObject({ sources: 3, links: 12 });
    // Within source: +1 (s1), +1 (s2), −1 (s3) → mean ⅓.
    expect(r.withinSource.prominence.value).toBeCloseTo(1 / 3, 12);
    expect(r.withinSource.sources).toBe(3);
    // Hit@1: s1 and s2 yes, s3 no.
    expect(r.hitAt1.prominence.value).toBeCloseTo(2 / 3, 12);
    // Link counts are flat on s1 and s3 (no Spearman), on s2 the double link is the top one.
    expect(r.withinSource.linkCount.value).toBeCloseTo(
      spearmanOf([2, 1, 1, 1], [40, 30, 20, 0]) as number,
      12,
    );
    expect(r.pooled.prominence.value).not.toBeNull();
    expect(r.pooled.difference.value).toBeCloseTo(
      (r.pooled.prominence.value as number) - (r.pooled.linkCount.value as number),
      12,
    );
  });
});

describe("Search Console", () => {
  it("parses a Pages export (BOM, any column order, thousands separators)", () => {
    const csv =
      '﻿Top pages,Clicks,Impressions,CTR,Position\nhttps://s.test/a,"1,234",9000,1%,3.2\nhttps://s.test/b,0,10,0%,40\n';
    expect(parseSearchConsoleCsv(csv)).toEqual([
      { url: "https://s.test/a", clicks: 1234, line: 2 },
      { url: "https://s.test/b", clicks: 0, line: 3 },
    ]);
    expect(parseSearchConsoleCsv("Clicks,Page\n5,https://s.test/c\n")[0]).toMatchObject({
      clicks: 5,
    });
  });

  it("reports every bad row, and refuses a file without the columns", () => {
    expect(() => parseSearchConsoleCsv("Top queries,Clicks\nturtles,5\n")).toThrow(
      SearchConsoleCsvError,
    );
    let error: unknown;
    try {
      parseSearchConsoleCsv("Page,Clicks\n,5\nhttps://s.test/x,-1\nhttps://s.test/y,2.5\n");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SearchConsoleCsvError);
    expect((error as SearchConsoleCsvError).problems).toHaveLength(3);
  });

  it("maps pages through the policy and compares the predictors with clicks", () => {
    // home → a, b, c; a → b; b → c; c → b. Clicks rise with the links each page receives.
    const e = (s: string, t: string, omega: number, obs = 1) => ({
      source: `${S}${s}`,
      target: `${S}${t}`,
      omega,
      structuralWeight: omega,
      observations: obs,
    });
    const edgesP = [
      e("/", "/a", 0.2),
      e("/", "/b", 0.3),
      e("/", "/c", 0.5),
      e("/a", "/b", 1),
      e("/b", "/c", 1),
      e("/c", "/b", 1, 2),
    ];
    const rows = [
      { url: `${S}/a`, clicks: 5, line: 2 },
      { url: `${S}/b/`, clicks: 70, line: 3 },
      { url: `${S}/c`, clicks: 40, line: 4 },
      { url: "https://other.test/x", clicks: 9, line: 5 },
      { url: `${S}/never-crawled`, clicks: 1, line: 6 },
      { url: "not a url", clicks: 1, line: 7 },
    ];
    const input = {
      pages: [`${S}/`, `${S}/a`, `${S}/b`, `${S}/c`],
      seed: `${S}/`,
      edges: edgesP,
      rows,
      isInternal: (u: string) => u.startsWith(S),
      // The policy strips a trailing slash (like P1).
      canonicalise: (u: string) => (u.endsWith("/") && u !== `${S}/` ? u.slice(0, -1) : u),
      zeroFill: false,
    };
    const t = pageTable(input, config);
    expect(t.rows).toEqual({ total: 6, used: 3, invalidUrl: 1, external: 1, notCrawled: 1 });
    expect(t.pages.map((p) => [p.node.replace(S, ""), p.clicks, p.inDegree])).toEqual([
      ["/a", 5, 1],
      ["/b", 70, 3],
      ["/c", 40, 2],
    ]);
    expect(t.pages.find((p) => p.node === `${S}/b`)?.inboundProminence).toBeCloseTo(
      0.3 + 1 + 1,
      12,
    );
    const r = pageLevel(t, false, config);
    expect(r.pages).toBe(3);
    expect(r.spearman.inDegree.value).toBe(1);
    // With zero-fill the home page joins with 0 clicks.
    expect(pageTable({ ...input, zeroFill: true }, config).pages).toHaveLength(4);
  });
});

describe("report", () => {
  it("renders Markdown with the prominence weights used", () => {
    const md = proxyMarkdown({
      version: "x",
      runId: 3,
      policyVersion: "P3@1.0.0",
      source: "clicks.csv",
      params: proxyParams(config),
      linkLevel: linkLevel(sourceLinks(edges, clicks), config),
    });
    expect(md).toContain("### Link level");
    expect(md).toContain("hit@1");
    expect(md).toContain('"body":1');
    expect(md).not.toContain("### Page level");
  });
});
