import { describe, expect, it } from "vitest";
import { canonicalise, makeConfig, type db as q } from "@linklens/core";
import {
  EXPLANATIONS,
  calibrateRun,
  parseAllInlinks,
  parseOrphanPages,
  parseScreamingFrog,
  type Calibration,
  type ScreamingFrogExport,
} from "./e5-screaming-frog.js";
import type { RunInputs } from "./in-memory.js";

const S = "https://s.test";

// ---------- parsing ----------

describe("parsing the three exports", () => {
  it("Internal: All, skipping a title line, columns by name", () => {
    const rows = parseScreamingFrog(
      [
        '"Internal - All"',
        "Address,Content Type,Status Code,Indexability,Crawl Depth,Unique Inlinks",
        `${S}/,text/html; charset=UTF-8,200,Indexable,0,"1,204"`,
        `${S}/c.pdf,application/pdf,200,Indexable,2,1`,
      ].join("\n"),
    );
    expect(rows[0]).toEqual({
      address: `${S}/`,
      statusCode: 200,
      contentType: "text/html; charset=UTF-8",
      crawlDepth: 0,
      uniqueInlinks: 1204,
      indexability: "Indexable",
    });
    expect(() => parseScreamingFrog("Foo,Bar\n1,2")).toThrow(/no address column/);
  });

  it("All Inlinks: type, source, destination and follow", () => {
    const links = parseAllInlinks(
      [
        "Type,Source,Destination,Alt Text,Anchor,Status Code,Follow,Link Position",
        `Hyperlink,${S}/,${S}/a,,A,200,true,Content`,
        `JavaScript,${S}/a,${S}/b,,,200,false,Navigation`,
      ].join("\n"),
    );
    expect(links).toEqual([
      {
        type: "Hyperlink",
        source: `${S}/`,
        destination: `${S}/a`,
        follow: true,
        linkPosition: "Content",
      },
      {
        type: "JavaScript",
        source: `${S}/a`,
        destination: `${S}/b`,
        follow: false,
        linkPosition: "Navigation",
      },
    ]);
    expect(() => parseAllInlinks("Address\nx")).toThrow(/All Inlinks/);
  });

  it("Orphan pages: Address (or URL) and its source when given", () => {
    expect(parseOrphanPages(`Address,Source\n${S}/o,Sitemap`)).toEqual([
      { address: `${S}/o`, source: "Sitemap" },
    ]);
    expect(parseOrphanPages(`URL\n${S}/o`)).toEqual([{ address: `${S}/o`, source: null }]);
  });
});

// ---------- the calibration ----------

let id = 1;
/** Our run: crawled pages with their links (path → [target, rel?]), fetch errors, discovery. */
function ourRun(
  pages: Record<string, [string, string?][]>,
  failed: Record<string, string>,
  disc: [q.DiscoveryObservationRow["channel"], string][],
  pageCap: number,
): RunInputs {
  const fetches: q.FetchRow[] = [];
  const pageRows: q.PageRow[] = [];
  const linkRows: q.LinkObservationRow[] = [];
  const fetch = (url: string, o: Partial<q.FetchRow>) => {
    const f = {
      id: id++,
      runId: 1,
      requestedUrl: url,
      finalUrl: url,
      statusCode: 200,
      redirectChain: [],
      headers: {},
      contentType: "text/html",
      fetchedAt: new Date(0),
      bytes: null,
      error: null,
      attempt: 1,
      purpose: "crawl",
      ...o,
    } as q.FetchRow;
    fetches.push(f);
    return f;
  };
  for (const [path, links] of Object.entries(pages)) {
    const f = fetch(S + path, {});
    pageRows.push({
      fetchId: f.id,
      url: S + path,
      title: path,
      h1: null,
      bodyText: "x",
      metaRobots: null,
      metaCanonical: null,
      nofollow: false,
    } as q.PageRow);
    links.forEach(([to, rel], i) =>
      linkRows.push({
        id: id++,
        runId: 1,
        sourceFetchId: f.id,
        rawHref: to,
        resolvedUrl: S + to,
        anchorText: to,
        rel: rel ?? null,
        domRegion: "main",
        domPath: null,
        templateSignature: null,
        positionIndex: i,
      }),
    );
  }
  for (const [path, error] of Object.entries(failed))
    fetch(S + path, { statusCode: null, error, finalUrl: null });
  return {
    runId: 1,
    startedAt: new Date(0),
    config: makeConfig({ pageCap }),
    observations: {
      runId: 1,
      seedUrl: `${S}/`,
      pages: pageRows.map((p) => ({ fetchId: p.fetchId, url: p.url })),
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
    pages: pageRows,
    linkRows,
    fetches,
    discovery: [
      {
        id: 0,
        runId: 1,
        channel: "link_graph",
        url: `${S}/`,
        sourceDocument: null,
        observedAt: new Date(0),
        detail: { kind: "seed" },
      },
      ...disc.map(([channel, path], i) => ({
        id: i + 1,
        runId: 1,
        channel,
        url: S + path,
        sourceDocument: `${S}/doc-${channel}`,
        observedAt: new Date(0),
        detail: {},
      })),
    ],
    cosine: null,
  };
}

// LinkLens: / → /a, /b, /capped, /robots-blocked, /nf (nofollow); /a → /deep. /x unlinked.
const ours = ourRun(
  {
    "/": [["/a"], ["/b"], ["/capped"], ["/robots-blocked"], ["/nf", "nofollow"]],
    "/a": [["/deep"]],
    "/b": [],
    "/deep": [],
    "/nf": [],
    "/x": [],
  },
  { "/robots-blocked": "blocked by robots.txt: /robots-blocked: disallow / (line 2)" },
  [
    ["xml_sitemap", "/lost2"],
    ["feed", "/feed-orphan"],
  ],
  7,
);

const row = (path: string, depth: number | null, status = 200, inlinks: number | null = null) => ({
  address: path.startsWith("http") ? path : S + path,
  statusCode: status,
  contentType: "text/html; charset=utf-8",
  crawlDepth: depth,
  uniqueInlinks: inlinks,
  indexability: "Indexable",
});
const link = (type: string, from: string, to: string) => ({
  type,
  source: S + from,
  destination: to.startsWith("http") ? to : S + to,
  follow: true,
  linkPosition: "Content",
});
// Screaming Frog: /deep one click from the home page (a link LinkLens lacks), /b/ with a slash,
// a JavaScript link to /js-only, a subdomain, and more links into /a.
const sf: ScreamingFrogExport = {
  internal: [
    row("/", 0, 200, 0),
    row("/a", 1, 200, 4),
    row("/b/", 1, 200, 1),
    row("/deep", 1, 200, 1),
    row("/robots-blocked", 1),
    row("/capped", 1),
    row("/js-only", 2),
    row("/sitemap-only", null),
    row("https://sub.s.test/page", 1),
    row("/x", 1, 404),
  ],
  inlinks: [
    link("Hyperlink", "/", "/a"),
    link("Hyperlink", "/", "/b/"),
    link("Hyperlink", "/", "/deep"),
    link("Hyperlink", "/", "/robots-blocked"),
    link("Hyperlink", "/", "/capped"),
    link("Hyperlink", "/", "https://sub.s.test/page"),
    link("JavaScript", "/a", "/js-only"),
    link("Hyperlink", "/deep", "/a"),
    link("Hyperlink", "/b/", "/a"),
    link("Hyperlink", "/capped", "/a"),
  ],
  orphans: [
    { address: `${S}/sitemap-only`, source: "Sitemap" },
    { address: `${S}/lost`, source: "Google Analytics" },
    { address: `${S}/lost2`, source: "Sitemap" },
    { address: `${S}/nf`, source: "Sitemap" },
  ],
};

const config = { ...makeConfig({ pageCap: 7 }), e5LargeMin: 1 };
const result: Calibration = calibrateRun(ours, sf, ["P0", "P3"], config);
const [p0, p3] = result.policies as [
  Calibration["policies"][number],
  Calibration["policies"][number],
];
const cat = (c: Calibration["policies"][number], kind: string, path: string) =>
  c.disagreements.find(
    (d) => d.kind === kind && d.node === (path.startsWith("http") ? path : S + path),
  )?.category;

describe("calibrateRun", () => {
  it("compares the URL sets under each policy", () => {
    expect(p3.urls).toEqual({ linklens: 6, screamingFrog: 9, common: 4, jaccard: 4 / 11 });
    // Under P0 /b and /b/ are two pages: one fewer in common.
    expect(p0.urls.common).toBe(3);
  });

  it("explains every URL only one tool crawled", () => {
    expect(cat(p3, "url-only-screaming-frog", "/robots-blocked")).toBe("robots-linklens");
    expect(cat(p3, "url-only-screaming-frog", "/capped")).toBe("page-cap");
    expect(cat(p3, "url-only-screaming-frog", "/js-only")).toBe("link-not-extracted");
    expect(cat(p3, "url-only-screaming-frog", "/sitemap-only")).toBe("sf-non-link");
    expect(cat(p3, "url-only-screaming-frog", "https://sub.s.test/page")).toBe("out-of-scope");
    expect(cat(p3, "url-only-linklens", "/nf")).toBe("nofollow");
    expect(cat(p3, "url-only-linklens", "/x")).toBe("status-screaming-frog");
    // P0 keeps /b and /b/ apart; under P3 they are one page.
    expect(cat(p0, "url-only-screaming-frog", "/b/")).toBe("normalisation");
    expect(cat(p0, "url-only-linklens", "/b")).toBe("normalisation");
    expect(p3.disagreements.some((d) => d.category === "normalisation")).toBe(false);
  });

  it("compares depths and explains a shorter path", () => {
    expect(p3.depth).toMatchObject({ pages: 4, seedDiffers: false });
    expect(p3.depth.exact).toBeCloseTo(3 / 4);
    expect(p3.depth.withinOne).toBe(1);
    // Screaming Frog reaches /deep straight from the home page, through a link LinkLens lacks.
    expect(cat(p3, "depth", "/deep")).toBe("link-not-extracted");
  });

  it("recomputes inlinks from All Inlinks under the same policy, and explains large gaps", () => {
    expect(p3.inlinks.largeDifferences).toBe(1);
    // /a: Screaming Frog has 4 linking pages (/, /deep, /b, /capped), LinkLens 1 (/).
    const d = p3.disagreements.find((x) => x.kind === "inlinks");
    expect(d).toMatchObject({ node: `${S}/a`, category: "link-not-extracted" });
    expect(d?.detail).toMatchObject({ linklens: 1, screamingFrog: 4 });
  });

  it("compares the orphan sets and explains each difference", () => {
    expect(p3.orphans).toEqual({ linklens: 2, screamingFrog: 4, common: 1, jaccard: 1 / 5 });
    expect(cat(p3, "orphan-only-screaming-frog", "/nf")).toBe("reachable-linklens");
    expect(cat(p3, "orphan-only-screaming-frog", "/lost")).toBe("not-in-linklens-channels");
    expect(cat(p3, "orphan-only-linklens", "/feed-orphan")).toBe(
      "channel-screaming-frog-does-not-read",
    );
  });

  it("summarises the categories with their explanation, share, examples and a large flag", () => {
    const c = p3.categories.find(
      (x) => x.kind === "orphan-only-screaming-frog" && x.category === "not-in-linklens-channels",
    );
    expect(c).toMatchObject({
      count: 2,
      share: 2 / 3,
      large: true,
      examples: [`${S}/lost`, `${S}/sitemap-only`],
    });
    // The template is filled from the evidence.
    expect(c?.explanation).toMatch(
      /Only Screaming Frog's orphan sources list it \((Google Analytics|Sitemap)\)/,
    );
    const js = p3.categories.find(
      (x) => x.kind === "url-only-screaming-frog" && x.category === "link-not-extracted",
    );
    expect(js?.explanation).toContain("(JavaScript)");
    // Every category used has an explanation.
    for (const pc of result.policies) {
      for (const x of pc.categories) expect(EXPLANATIONS[x.kind][x.category]).toBeDefined();
    }
    // With the default e5LargeMin (3), single disagreements are not large.
    const strict = calibrateRun(ours, sf, ["P3"], makeConfig({ pageCap: 7 }));
    expect(strict.policies[0]?.categories.filter((x) => x.large).map((x) => x.category)).toEqual(
      [],
    );
  });

  it("works with Internal: All alone (no inlink recount, no orphans)", () => {
    const r = calibrateRun(
      ours,
      { internal: sf.internal, inlinks: null, orphans: null },
      ["P3"],
      config,
    );
    const only = r.policies[0];
    expect(only?.inlinks.spearman).toBeNull();
    expect(only?.orphans.jaccard).toBeNull();
    expect(only?.urls.common).toBe(4);
  });
});
