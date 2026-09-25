import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT, p1 } from "../canonicalise/index.js";
import { makeInternalTest } from "../graph/scope.js";
import { reconcile, type ObservationInput } from "./reconcile.js";

const S = "https://site.test";
const obs = (
  channel: ObservationInput["channel"],
  path: string,
  source: string | null = null,
  detail: ObservationInput["detail"] = {},
): ObservationInput => ({
  channel,
  url: path.startsWith("http") || path.includes(":") ? path : S + path,
  sourceDocument: source,
  detail,
});

// Link graph: / → /a, /b.  /b is crawled but only /a and / are linked from the seed…
const graph = new Map([
  [`${S}/`, { reachable: true, depth: 0 }],
  [`${S}/a`, { reachable: true, depth: 1 }],
  [`${S}/b`, { reachable: true, depth: 1 }],
  [`${S}/island`, { reachable: false, depth: null }], // crawled but unreachable
]);

const observations: ObservationInput[] = [
  obs("link_graph", "/", null, { kind: "seed" }),
  obs("link_graph", "/a", `${S}/`),
  obs("link_graph", "/b", `${S}/`),
  obs("link_graph", "/b#frag", `${S}/a`),
  obs("xml_sitemap", "/a", `${S}/sitemap.xml`),
  obs("xml_sitemap", "/sitemap-only", `${S}/sitemap.xml`),
  obs("robots_sitemap", "/sitemap.xml", `${S}/robots.txt`, { kind: "directive", line: 3 }),
  obs("robots_sitemap", "/a", `${S}/sitemap_index.xml`),
  obs("robots_sitemap", "/declared-only", `${S}/sitemap_index.xml`),
  obs("feed", "/feed-only", `${S}/feed.xml`),
  obs("feed", "/a", `${S}/feed.xml`),
  obs("html_sitemap", "/island", `${S}/sitemap.html`),
  obs("llms_txt", "/b", `${S}/llms.txt`),
  obs("llms_txt", "https://elsewhere.test/x", `${S}/llms.txt`),
  obs("link_graph", "mailto:hi@site.test", `${S}/`),
];

const run = (policy = (u: string) => p1(u, EMPTY_CONTEXT)) =>
  reconcile({
    runId: 1,
    policyVersion: "P1@1.0.0",
    observations,
    isInternal: makeInternalTest(`${S}/`, false),
    canonicalise: policy,
    graph,
  });

describe("reconcile", () => {
  const r = run();
  const entry = (path: string) => r.inventory.find((e) => e.node === S + path);

  it("builds the inventory as the union of channels, under the policy", () => {
    expect(r.inventory.map((e) => e.node)).toEqual(
      ["/", "/a", "/b", "/declared-only", "/feed-only", "/island", "/sitemap-only"].map(
        (p) => S + p,
      ),
    );
    expect(entry("/b")?.urls).toEqual([`${S}/b`, `${S}/b#frag`]); // P1 drops the fragment
  });

  it("records which channels found each URL, in channel order, with their documents", () => {
    expect(entry("/a")).toMatchObject({
      channels: ["link_graph", "xml_sitemap", "robots_sitemap", "feed"],
      sources: {
        link_graph: [`${S}/`],
        xml_sitemap: [`${S}/sitemap.xml`],
        robots_sitemap: [`${S}/sitemap_index.xml`],
        feed: [`${S}/feed.xml`],
      },
      reachable: true,
      depth: 1,
      orphan: false,
    });
    expect(entry("/b")?.sources.link_graph).toEqual([`${S}/`, `${S}/a`]);
    expect(entry("/")?.sources.link_graph).toEqual([null]); // the seed
  });

  it("flags orphans: found by a non-link channel, not reachable in the link graph", () => {
    expect(r.orphans).toEqual(
      ["/declared-only", "/feed-only", "/island", "/sitemap-only"].map((p) => S + p),
    );
    expect(entry("/island")).toMatchObject({ reachable: false, orphan: true, depth: null });
    expect(entry("/b")?.orphan).toBe(false); // llms.txt + reachable
  });

  it("computes each channel's total, marginal yield (exclusive) and orphans", () => {
    expect(r.channels).toEqual({
      link_graph: { total: 3, exclusive: 1, orphans: 0 }, // "/" only via the link graph
      xml_sitemap: { total: 2, exclusive: 1, orphans: 1 },
      robots_sitemap: { total: 2, exclusive: 1, orphans: 1 },
      html_sitemap: { total: 1, exclusive: 1, orphans: 1 },
      feed: { total: 2, exclusive: 1, orphans: 1 },
      llms_txt: { total: 1, exclusive: 0, orphans: 0 },
    });
  });

  it("skips robots.txt directives (sitemap files) and external/non-http URLs", () => {
    expect(r.skipped).toEqual({ external: 2, directives: 1 });
    expect(entry("/sitemap.xml")).toBeUndefined();
  });

  it("merges more under a coarser policy", () => {
    const coarse = run((u) => (u.startsWith(S) ? `${S}/` : u)); // everything internal → one node
    expect(coarse.inventory).toHaveLength(1);
    expect(coarse.orphans).toEqual([]);
    expect(coarse.inventory[0]?.channels).toHaveLength(6);
  });

  it("is deterministic in observation order", () => {
    const reversed = reconcile({
      runId: 1,
      policyVersion: "P1@1.0.0",
      observations: [...observations].reverse(),
      isInternal: makeInternalTest(`${S}/`, false),
      canonicalise: (u) => p1(u, EMPTY_CONTEXT),
      graph,
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(r));
  });
});
