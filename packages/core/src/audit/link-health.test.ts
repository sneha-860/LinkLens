import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import type { RedirectHop } from "../db/types.js";
import { linkHealth, type LinkHealthInput } from "./link-health.js";

const S = "https://site.test";
const page = (fetchId: number, path: string) => ({ fetchId, url: S + path });
let id = 0;
const link = (from: number, href: string, anchor = "a link", region: string | null = "main") => ({
  id: ++id,
  sourceFetchId: from,
  // A path is resolved against the site; an href with a scheme (https:, mailto:) is kept.
  resolvedUrl: /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : S + href,
  anchorText: anchor,
  domRegion: region,
  positionIndex: id,
});
const hop = (path: string, statusCode = 301, to?: string): RedirectHop => ({
  url: S + path,
  statusCode,
  location: to === undefined ? null : S + to,
});
const fetch = (
  path: string,
  statusCode: number | null,
  chain: RedirectHop[] = [],
  finalPath: string | null = path,
  error: string | null = null,
  purpose: "crawl" | "discovery" = "crawl",
) => ({
  requestedUrl: S + path,
  finalUrl: finalPath === null ? null : S + finalPath,
  statusCode,
  redirectChain: chain,
  error,
  purpose,
});

const input: LinkHealthInput = {
  runId: 1,
  policyVersion: "P3@1.0.0",
  pages: [page(1, "/"), page(2, "/blog/"), page(3, "/about")],
  links: [
    // Home: a 404 twice (nav + body), a 500, a 2-hop chain, a 1-hop redirect, a fine page.
    link(1, "/gone", "Old page", "nav"),
    link(1, "/gone#top", "Old page (again)", "main"),
    link(1, "/flaky", "Flaky"),
    link(1, "/old", "Moved twice"),
    link(1, "/renamed", "Moved once"),
    link(1, "/about", "About"),
    // Blog: the same 404, a 3-hop chain ending in 404, an unchecked link, a robots-blocked one,
    // an external link and a mailto (both ignored).
    link(2, "/gone", "Gone", "footer"),
    link(2, "/a", "Chain to nowhere"),
    link(2, "/never-fetched", "Beyond the cap"),
    link(2, "/private", "Blocked"),
    link(2, "https://other.test/x", "Elsewhere"),
    link(2, "mailto:someone@site.test", "Mail"),
    // A link on a page that was not crawled (e.g. a rescue page) is not counted.
    link(99, "/gone", "Ghost"),
  ],
  fetches: [
    fetch("/", 200),
    fetch("/blog/", 200),
    fetch("/about", 200),
    fetch("/gone", 404),
    fetch("/flaky", 503, [], "/flaky", "HTTP 503"),
    fetch("/old", 200, [hop("/old", 301, "/older"), hop("/older", 302, "/new")], "/new"),
    fetch("/renamed", 200, [hop("/renamed", 301, "/new")], "/new"),
    fetch("/a", 404, [hop("/a", 301, "/b"), hop("/b", 301, "/c"), hop("/c", 302, "/d")], "/d"),
    fetch("/private", null, [], null, "blocked by robots.txt"),
    // A discovery fetch of a linked URL does not count: the crawl never fetched it.
    fetch("/never-fetched", 404, [], "/never-fetched", null, "discovery"),
  ],
  isInternal: (url) => url.startsWith(S),
  node: (url) => url.replace(/\/$/, "") || url,
};
const config = makeConfig();
const report = linkHealth(input, config);

describe("linkHealth", () => {
  it("counts every internal link on crawled pages and what could be checked", () => {
    expect(report.summary).toMatchObject({
      internalLinks: 10,
      checkedLinks: 8,
      uncheckedLinks: 1,
      failedLinks: 1,
      brokenTargets: 3,
      brokenLinks: 5,
      brokenSourcePages: 2,
      statuses: { "404": 2, "503": 1 },
      redirectTargets: 3,
      chainTargets: 2,
      chainLinks: 2,
      maxHops: 3,
      minChainHops: 2,
    });
  });

  it("lists broken targets with their source pages, anchors and regions, most linked first", () => {
    expect(
      report.broken.map((b) => [b.url.replace(S, ""), b.finalStatus, b.class, b.links, b.hops]),
    ).toEqual([
      ["/gone", 404, "4xx", 3, 0],
      ["/a", 404, "4xx", 1, 3],
      ["/flaky", 503, "5xx", 1, 0],
    ]);
    const gone = report.broken[0];
    expect(gone?.sources).toEqual([
      {
        page: `${S}/`,
        node: S,
        links: 2,
        anchors: ["Old page", "Old page (again)"],
        regions: ["nav", "main"],
      },
      { page: `${S}/blog/`, node: `${S}/blog`, links: 1, anchors: ["Gone"], regions: ["footer"] },
    ]);
    // The fragment is dropped, as the crawler requested it.
    expect(gone?.url).toBe(`${S}/gone`);
  });

  it("lists redirect chains of two hops or more, longest first, with the whole chain", () => {
    expect(
      report.redirectChains.map((c) => [c.url.replace(S, ""), c.hops, c.finalStatus, c.endsBroken]),
    ).toEqual([
      ["/a", 3, 404, true],
      ["/old", 2, 200, false],
    ]);
    expect(report.redirectChains[1]?.chain.map((h) => h.url.replace(S, ""))).toEqual([
      "/old",
      "/older",
    ]);
    expect(report.redirectChains[1]?.finalUrl).toBe(`${S}/new`);
    // The single-hop redirect is counted, not listed.
    expect(report.redirectChains.some((c) => c.url.endsWith("/renamed"))).toBe(false);
  });

  it("lists single hops too with a lower minimum, and flags a chain that never ends", () => {
    const loose = linkHealth(
      {
        ...input,
        fetches: [
          ...input.fetches,
          fetch(
            "/loop",
            301,
            [hop("/loop", 301, "/loop2"), hop("/loop2", 301, "/loop")],
            "/loop2",
            "more than 1 redirects",
          ),
        ],
        links: [...input.links, link(3, "/loop", "Loop")],
      },
      makeConfig({ linkHealthMinChainHops: 1 }),
    );
    expect(loose.redirectChains.map((c) => c.url.replace(S, ""))).toEqual([
      "/a",
      "/loop",
      "/old",
      "/renamed",
    ]);
    expect(loose.redirectChains.find((c) => c.url.endsWith("/loop"))).toMatchObject({
      endsBroken: true,
      error: "more than 1 redirects",
    });
  });

  it("is deterministic whatever the input order", () => {
    const shuffled = linkHealth(
      {
        ...input,
        links: [...input.links].reverse(),
        pages: [...input.pages].reverse(),
        fetches: [...input.fetches].reverse(),
      },
      config,
    );
    expect(shuffled).toEqual(report);
  });
});
