import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT, p1 } from "../canonicalise/index.js";
import { makeInternalTest } from "../graph/scope.js";
import { leaveOneChannelOut } from "./ablation.js";
import { DISCOVERY_CHANNELS } from "./channels.js";
import { reconcile, type ObservationInput, type ReconcileInput } from "./reconcile.js";

const S = "https://site.test";
const obs = (
  channel: ObservationInput["channel"],
  path: string,
  detail: ObservationInput["detail"] = {},
): ObservationInput => ({ channel, url: S + path, sourceDocument: null, detail });

// Reachable: /, /a. Orphans: /s (XML sitemap only), /f (feed + llms.txt), /i (HTML sitemap only,
// also linked from an unreachable page).
const input: ReconcileInput = {
  runId: 1,
  policyVersion: "P1@1.0.0",
  observations: [
    obs("link_graph", "/", { kind: "seed" }),
    obs("link_graph", "/a"),
    obs("link_graph", "/i"),
    obs("link_graph", "/link-only"),
    obs("xml_sitemap", "/a"),
    obs("xml_sitemap", "/s"),
    obs("robots_sitemap", "/sitemap.xml", { kind: "directive" }),
    obs("robots_sitemap", "/a"),
    obs("feed", "/f"),
    obs("llms_txt", "/f"),
    obs("html_sitemap", "/i"),
  ],
  isInternal: makeInternalTest(`${S}/`, false),
  canonicalise: (u) => p1(u, EMPTY_CONTEXT),
  graph: new Map([
    [`${S}/`, { reachable: true, depth: 0 }],
    [`${S}/a`, { reachable: true, depth: 1 }],
    [`${S}/i`, { reachable: false, depth: null }],
    [`${S}/link-only`, { reachable: true, depth: 1 }],
  ]),
};

describe("leaveOneChannelOut", () => {
  const r = leaveOneChannelOut(input);
  const removal = (c: string) => r.removals.find((x) => x.channel === c);

  it("recomputes the reconciliation without each channel, in channel order", () => {
    expect(r).toMatchObject({ inventory: 6, orphans: 3 });
    expect(r.removals.map((x) => x.channel)).toEqual([...DISCOVERY_CHANNELS]);
    for (const x of r.removals) {
      const without = reconcile({
        ...input,
        observations: input.observations.filter((o) => o.channel !== x.channel),
      });
      expect(x.inventoryWithout).toBe(without.inventory.length);
      expect(x.orphansWithout).toBe(without.orphans.length);
      expect(x.orphansWithout).toBe(r.orphans - x.orphansExclusive);
    }
  });

  it("measures each channel's marginal yield of pages and of orphans", () => {
    expect(removal("xml_sitemap")).toMatchObject({
      pagesTotal: 2,
      pagesExclusive: 1, // /s (the sitemap shares /a with others)
      orphansTotal: 1,
      orphansExclusive: 1,
      orphansExclusiveShare: 1 / 3,
      lostOrphans: [`${S}/s`],
    });
    // /f is found by the feed and llms.txt: neither alone is needed.
    expect(removal("feed")).toMatchObject({
      orphansTotal: 1,
      orphansExclusive: 0,
      pagesExclusive: 0,
    });
    expect(removal("llms_txt")).toMatchObject({ orphansExclusive: 0 });
    // The HTML sitemap is the only non-link channel for /i, which the link graph also lists.
    expect(removal("html_sitemap")).toMatchObject({
      pagesExclusive: 0,
      orphansExclusive: 1,
      lostOrphans: [`${S}/i`],
    });
    // The robots.txt directive is a sitemap file, not a page.
    expect(removal("robots_sitemap")).toMatchObject({ pagesTotal: 1, pagesExclusive: 0 });
  });

  it("never loses an orphan by removing the link graph, only pages", () => {
    expect(removal("link_graph")).toMatchObject({
      pagesExclusive: 2, // the seed and /link-only
      orphansExclusive: 0,
      orphansWithout: 3,
    });
  });

  it("splits the orphans by the non-link channels that reveal them", () => {
    expect(r.orphansBy).toEqual({
      only: {
        link_graph: 0,
        xml_sitemap: 1,
        robots_sitemap: 0,
        html_sitemap: 1,
        feed: 0,
        llms_txt: 0,
      },
      several: 1,
    });
    const onlySum = Object.values(r.orphansBy.only).reduce((a, b) => a + b, 0);
    expect(onlySum + r.orphansBy.several).toBe(r.orphans);
    // Detected only by a channel = lost without it.
    for (const x of r.removals) expect(x.orphansExclusive).toBe(r.orphansBy.only[x.channel]);
  });

  it("has no share when there are no orphans", () => {
    const none = leaveOneChannelOut({ ...input, observations: input.observations.slice(0, 4) });
    expect(none.orphans).toBe(0);
    expect(none.removals.every((x) => x.orphansExclusiveShare === null)).toBe(true);
  });
});
