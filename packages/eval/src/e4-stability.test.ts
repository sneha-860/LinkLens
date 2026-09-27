import { describe, expect, it } from "vitest";
import { canonicalise, makeConfig, type db as q } from "@linklens/core";
import {
  classifyPages,
  compareOutcomes,
  discoveryDocuments,
  pageSignatures,
} from "./e4-stability.js";
import type { AuditOutcome, RunInputs } from "./in-memory.js";

const S = "https://s.test";
let nextId = 1;

interface Page {
  readonly path: string;
  readonly title?: string;
  readonly links?: string[];
}

/** A run: crawled pages (with links), extra fetches (non-2xx or errors) and discovery rows. */
function run(
  pages: Page[],
  extra: Partial<Pick<q.FetchRow, "requestedUrl" | "finalUrl" | "statusCode" | "error">>[] = [],
  disc: Pick<q.DiscoveryObservationRow, "channel" | "url" | "sourceDocument">[] = [],
): RunInputs {
  const fetches: q.FetchRow[] = [];
  const pageRows: q.PageRow[] = [];
  const linkRows: q.LinkObservationRow[] = [];
  const fetch = (f: Partial<q.FetchRow>): q.FetchRow => {
    const row = {
      id: nextId++,
      runId: 1,
      requestedUrl: "",
      finalUrl: null,
      statusCode: null,
      redirectChain: [],
      headers: {},
      contentType: "text/html",
      fetchedAt: new Date(0),
      bytes: null,
      error: null,
      attempt: 1,
      purpose: "crawl",
      ...f,
    } as q.FetchRow;
    fetches.push(row);
    return row;
  };
  for (const p of pages) {
    const f = fetch({ requestedUrl: S + p.path, finalUrl: S + p.path, statusCode: 200 });
    pageRows.push({
      id: f.id,
      runId: 1,
      fetchId: f.id,
      url: S + p.path,
      title: p.title ?? p.path,
      h1: null,
      headings: [],
      metaCanonical: null,
      metaRobots: null,
      bodyText: "text",
      paragraphs: [],
      lang: null,
      nofollow: false,
      baseHref: null,
    });
    (p.links ?? []).forEach((l, i) =>
      linkRows.push({
        id: nextId++,
        runId: 1,
        sourceFetchId: f.id,
        rawHref: l,
        resolvedUrl: S + l,
        anchorText: l,
        rel: null,
        domRegion: "main",
        domPath: null,
        templateSignature: null,
        positionIndex: i,
      }),
    );
  }
  for (const e of extra) fetch(e);
  return {
    runId: 1,
    startedAt: new Date(0),
    config: makeConfig(),
    observations: { runId: 1, seedUrl: `${S}/`, pages: [], links: [] },
    context: canonicalise.EMPTY_CONTEXT,
    pages: pageRows,
    linkRows,
    fetches,
    discovery: disc.map((d, i) => ({ id: i, runId: 1, observedAt: new Date(0), detail: {}, ...d })),
    cosine: null,
  };
}

describe("pageSignatures", () => {
  it("changes with the text or any link, not with fetch ids", () => {
    const a = pageSignatures(run([{ path: "/", links: ["/x"] }]));
    expect(pageSignatures(run([{ path: "/", links: ["/x"] }]))).toEqual(a);
    expect(pageSignatures(run([{ path: "/", links: ["/y"] }]))).not.toEqual(a);
    expect(pageSignatures(run([{ path: "/", title: "New", links: ["/x"] }]))).not.toEqual(a);
  });
});

describe("classifyPages", () => {
  const home = { path: "/", links: ["/a", "/b", "/c", "/d", "/e", "/f", "/g"] };
  const a = run([
    home,
    ...["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"].map((path) => ({ path })),
  ]);
  const b = run(
    [home, { path: "/a", title: "rewritten" }, { path: "/new" }, { path: "/linked-before" }],
    [
      { requestedUrl: `${S}/b`, finalUrl: `${S}/b`, statusCode: 410 },
      { requestedUrl: `${S}/c`, finalUrl: `${S}/a`, statusCode: 200 },
      { requestedUrl: `${S}/d`, finalUrl: `${S}/d`, statusCode: 200 },
      { requestedUrl: `${S}/e`, error: "blocked by robots.txt: /e: disallow /e (line 2)" },
      { requestedUrl: `${S}/f`, error: "blocked by robots.txt: /f: robots.txt unreachable (5xx)" },
      { requestedUrl: `${S}/g`, statusCode: 503 },
    ],
  );
  // A linked to /linked-before but did not fetch it.
  const a2 = run([
    ...a.pages.map((p) => ({ path: p.url.slice(S.length) })),
    { path: "/z", links: ["/linked-before"] },
  ]);
  const by = (cls: ReturnType<typeof classifyPages>) =>
    new Map(cls.map((c) => [c.node.slice(S.length), c]));

  it("tells the site's changes from the crawl's misses", () => {
    const c = by(classifyPages(a, b));
    expect(c.get("/")).toMatchObject({ status: "unchanged", cause: null });
    expect(c.get("/a")).toMatchObject({ status: "changed", cause: "site" });
    expect(c.get("/b")).toMatchObject({ status: "onlyA", cause: "site", reason: "gone" });
    expect(c.get("/c")).toMatchObject({ status: "onlyA", cause: "site", reason: "redirect" });
    expect(c.get("/d")).toMatchObject({ status: "onlyA", cause: "site", reason: "not-html" });
    expect(c.get("/e")).toMatchObject({ status: "onlyA", cause: "site", reason: "robots" });
    expect(c.get("/f")).toMatchObject({ status: "onlyA", cause: "method", reason: "failed" });
    expect(c.get("/g")).toMatchObject({ status: "onlyA", cause: "method", reason: "failed" });
    // /h: never fetched, and nothing in B links to it any more.
    expect(c.get("/h")).toMatchObject({ status: "onlyA", cause: "site", reason: "link" });
    // /new: nothing in A linked to it: a new page.
    expect(c.get("/new")).toMatchObject({ status: "onlyB", cause: "site", reason: "link" });
  });

  it("a page the other run linked to but never fetched is the crawl's miss", () => {
    const c = by(classifyPages(a2, b));
    expect(c.get("/linked-before")).toMatchObject({
      status: "onlyB",
      cause: "method",
      reason: "not-admitted",
    });
  });
});

describe("discoveryDocuments", () => {
  it("keys each document by channel and source, with its sorted P3 URLs", () => {
    const d = (urls: string[]) =>
      discoveryDocuments(
        run(
          [],
          [],
          urls.map((u) => ({
            channel: "xml_sitemap",
            url: S + u,
            sourceDocument: `${S}/sitemap.xml`,
          })),
        ),
      );
    expect(d(["/b", "/a/"])).toEqual(d(["/a", "/b"])); // P3 form, sorted
    expect(d(["/a", "/c"])).not.toEqual(d(["/a", "/b"]));
  });
});

describe("compareOutcomes", () => {
  const outcome = (
    crawled: string[],
    orphans: string[],
    fixes: string[],
    pr: number[],
  ): AuditOutcome => ({
    crawled: new Set(crawled),
    pagerank: new Map(crawled.map((n, i) => [n, pr[i] as number])),
    orphans: new Set(orphans),
    topFixes: new Set(fixes),
    fixes: fixes.length,
  });

  it("measures node overlap, PageRank Spearman, orphan Jaccard and top-k fix overlap", () => {
    const c = compareOutcomes(
      outcome(["a", "b", "c"], ["o"], ["a -> b", "c -> b"], [0.5, 0.3, 0.2]),
      outcome(["a", "b", "d"], ["o", "p"], ["a -> b"], [0.6, 0.3, 0.1]),
    );
    expect(c).toMatchObject({
      crawledA: 3,
      crawledB: 3,
      nodeJaccard: 0.5,
      sharedNodes: 2,
      orphanJaccard: 0.5,
      topFixesJaccard: 0.5,
    });
    expect(c.pagerankSpearman).toBeCloseTo(1); // a above b in both
  });
});
