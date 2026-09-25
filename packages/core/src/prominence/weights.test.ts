import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT, POLICIES } from "../canonicalise/index.js";
import { makeConfig } from "../config.js";
import { makeInternalTest } from "../graph/scope.js";
import { mapClicks } from "./run.js";
import {
  computeProminence,
  observationFactors,
  regionClass,
  type NodeClicks,
  type PageLink,
  type PageLinks,
} from "./weights.js";

const config = makeConfig();
let nextId = 0;
/** [target | null, region, signature?] in document order. */
const page = (node: string, links: [string | null, string | null, string?][]): PageLinks => ({
  node,
  links: links.map(([target, domRegion, sig], i): PageLink => ({
    observationId: ++nextId,
    domRegion,
    templateSignature: sig ?? null,
    positionIndex: i,
    target,
  })),
});
const edge = (p: ReturnType<typeof computeProminence>, s: string, t: string) => {
  const e = p.edges.find((x) => x.source === s && x.target === t);
  if (e === undefined) throw new Error(`no edge ${s}→${t}`);
  return e;
};

describe("regionWeight", () => {
  it("classes main, body and a missing region as body; keeps the chrome regions", () => {
    expect(regionClass("main")).toBe("body");
    expect(regionClass("body")).toBe("body");
    expect(regionClass(null)).toBe("body");
    expect(regionClass("footer")).toBe("footer");
    expect(regionClass("breadcrumb")).toBe("breadcrumb");
  });

  it("weights each link by its region (defaults: body 1, breadcrumb 0.5, aside 0.4, header 0.3, nav 0.3, pagination 0.2, footer 0.1)", () => {
    const regions = ["breadcrumb", "aside", "header", "nav", "pagination", "footer", "main"];
    const p = computeProminence(
      {
        pages: [
          page(
            "A",
            regions.map((r) => [`T-${r}`, r]),
          ),
        ],
      },
      config,
    );
    expect(Object.fromEntries(p.edges.map((e) => [e.target, e.weight]))).toEqual({
      "T-breadcrumb": 0.5,
      "T-aside": 0.4,
      "T-header": 0.3,
      "T-nav": 0.3,
      "T-pagination": 0.2,
      "T-footer": 0.1,
      "T-main": 1, // the only body link: rank 0
    });
    expect(edge(p, "A", "T-nav").regions).toEqual({ nav: 1 });
  });

  it("uses the configured weights", () => {
    const custom = makeConfig({
      prominenceRegionWeights: { ...config.prominenceRegionWeights, footer: 0 },
    });
    const p = computeProminence({ pages: [page("A", [["B", "footer"]])] }, custom);
    expect(edge(p, "A", "B").weight).toBe(0);
  });
});

describe("positionFactor", () => {
  it("is 1 / (1 + 0.1 × rank) over the page's body links in document order", () => {
    const p = computeProminence(
      {
        pages: [
          page("A", [
            ["B", "main"], // body rank 0
            ["N", "nav"], // not a body link: no rank, factor 1
            ["C", "body"], // body rank 1
            [null, "main"], // external body link: still takes rank 2
            ["D", "main"], // body rank 3
          ]),
        ],
      },
      config,
    );
    expect(edge(p, "A", "B").weight).toBe(1);
    expect(edge(p, "A", "N").weight).toBeCloseTo(0.3, 12);
    expect(edge(p, "A", "C").weight).toBeCloseTo(1 / 1.1, 12);
    expect(edge(p, "A", "D").weight).toBeCloseTo(1 / 1.3, 12);
  });

  it("orders by position_index, not by input order", () => {
    const links: PageLink[] = [
      {
        observationId: 900,
        domRegion: "main",
        templateSignature: null,
        positionIndex: 5,
        target: "LATE",
      },
      {
        observationId: 901,
        domRegion: "main",
        templateSignature: null,
        positionIndex: 0,
        target: "EARLY",
      },
    ];
    const p = computeProminence({ pages: [{ node: "A", links }] }, config);
    expect(edge(p, "A", "EARLY").weight).toBe(1);
    expect(edge(p, "A", "LATE").weight).toBeCloseTo(1 / 1.1, 12);
  });

  it("does nothing with a decay of 0", () => {
    const p = computeProminence(
      {
        pages: [
          page("A", [
            ["B", "main"],
            ["C", "main"],
            ["D", "main"],
          ]),
        ],
      },
      makeConfig({ prominencePositionDecay: 0 }),
    );
    expect(p.edges.map((e) => e.weight)).toEqual([1, 1, 1]);
  });
});

describe("sitewideDiscount", () => {
  // 4 pages. "menu" is on 3 of them (75% > 50%): discounted. "pair" is on 2 (exactly 50%): not.
  const pages = [
    page("P1", [
      ["X", "nav", "menu"],
      ["Y", "main", "pair"],
    ]),
    page("P2", [
      ["X", "nav", "menu"],
      ["Y", "main", "pair"],
    ]),
    page("P3", [["X", "nav", "menu"]]),
    page("P4", [["X", "main"]]),
  ];
  const p = computeProminence({ pages }, config);

  it("multiplies links of a template on more than 50% of pages by 0.3", () => {
    expect(edge(p, "P1", "X").weight).toBeCloseTo(0.3 * 0.3, 12); // nav × site-wide
    expect(p.stats.sitewideTemplates).toEqual([{ signature: "menu", pages: 3, share: 0.75 }]);
  });

  it("leaves a template on exactly 50% of pages, and links with no signature, alone", () => {
    expect(edge(p, "P1", "Y").weight).toBe(1); // first body link (nav takes no rank), no discount
    expect(edge(p, "P4", "X").weight).toBe(1);
  });

  it("exposes each observation's three factors", () => {
    const { factors } = observationFactors(pages, config);
    const f = [...factors.values()].find((x) => x.sitewide);
    expect(f).toMatchObject({
      region: "nav",
      regionWeight: 0.3,
      bodyRank: null,
      positionFactor: 1,
      sitewideDiscount: 0.3,
    });
    expect(f?.weight).toBeCloseTo(0.09, 12);
  });

  it("uses the configured share and discount", () => {
    const loose = computeProminence(
      { pages },
      makeConfig({ prominenceSitewideShare: 0.4, prominenceSitewideDiscount: 0.5 }),
    );
    expect(edge(loose, "P1", "Y").weight).toBeCloseTo(0.5, 12); // "pair" (50%) is now site-wide; rank 0
    expect(loose.stats.sitewideTemplates.map((t) => t.signature)).toEqual(["menu", "pair"]);
  });
});

describe("W and ω", () => {
  const p = computeProminence(
    {
      pages: [
        page("A", [
          ["B", "main"], // 1
          ["B", "footer"], // + 0.1 → W(A,B) = 1.1
          ["C", "main"], // 1/1.1
          ["A", "main"], // self-loop: not an edge (the caller passes null)…
        ]),
        page("B", [["A", "nav"]]),
      ],
    },
    config,
  );

  it("sums every observation u→v", () => {
    const ab = edge(p, "A", "B");
    expect(ab.weight).toBeCloseTo(1.1, 12);
    expect(ab.observations).toBe(2);
    expect(ab.regions).toEqual({ body: 1, footer: 1 });
    expect(ab.origin).toBe("structural");
    expect(ab.clicks).toBeNull();
  });

  it("normalises per source: ω(u,·) sums to 1", () => {
    const sums = new Map<string, number>();
    for (const e of p.edges) sums.set(e.source, (sums.get(e.source) ?? 0) + e.omega);
    for (const s of sums.values()) expect(s).toBeCloseTo(1, 12);
    const total = 1.1 + 1 / 1.1 + 1 / 1.2;
    expect(edge(p, "A", "B").omega).toBeCloseTo(1.1 / total, 12);
    expect(edge(p, "B", "A").omega).toBe(1);
  });

  it("gives ω = 0 when a source's weights are all 0", () => {
    const zero = computeProminence(
      { pages: [page("A", [["B", "footer"]])] },
      makeConfig({ prominenceRegionWeights: { ...config.prominenceRegionWeights, footer: 0 } }),
    );
    expect(edge(zero, "A", "B")).toMatchObject({ weight: 0, omega: 0 });
  });

  it("is sorted and deterministic", () => {
    expect(p.edges.map((e) => `${e.source}→${e.target}`)).toEqual(["A→A", "A→B", "A→C", "B→A"]);
  });
});

describe("analytics override", () => {
  const pages = [
    page("A", [
      ["B", "main"],
      ["C", "main"],
      ["D", "footer"],
    ]),
    page("B", [
      ["A", "main"],
      ["C", "main"],
    ]),
    page("C", [["A", "main"]]),
  ];
  const clicks: NodeClicks[] = [
    { source: "A", target: "B", clicks: 20 },
    { source: "A", target: "B", clicks: 10 }, // duplicates add up
    { source: "A", target: "C", clicks: 10 },
    { source: "B", target: "D", clicks: 99 }, // no link B→D
    { source: "C", target: "A", clicks: 0 }, // zero clicks: C is not overridden
    { source: "A", target: "A", clicks: 5 },
    { source: null, target: "A", clicks: 5, reason: "external" },
    { source: "A", target: null, clicks: 5, reason: "invalid-url" },
  ];
  const p = computeProminence({ pages, analytics: clicks }, config);

  it("replaces W by clicks for every edge of a source that has clicks", () => {
    expect(edge(p, "A", "B")).toMatchObject({
      weight: 30,
      omega: 0.75,
      origin: "analytics",
      clicks: 30,
    });
    expect(edge(p, "A", "C")).toMatchObject({ weight: 10, omega: 0.25, origin: "analytics" });
    // A link with no clicks from an overridden source gets 0.
    expect(edge(p, "A", "D")).toMatchObject({
      weight: 0,
      omega: 0,
      origin: "analytics",
      clicks: 0,
    });
    // The structural weight is kept for comparison.
    expect(edge(p, "A", "D").structuralWeight).toBeCloseTo(0.1, 12);
  });

  it("keeps the structural proxy for sources without usable clicks", () => {
    expect(edge(p, "B", "A").origin).toBe("structural");
    expect(edge(p, "C", "A")).toMatchObject({ origin: "structural", weight: 1, omega: 1 });
  });

  it("counts rows it cannot use", () => {
    expect(p.stats.analytics).toEqual({
      rows: 8,
      matchedRows: 4,
      unmatched: { invalidUrl: 1, external: 1, selfLoop: 1, noLink: 1 },
      overriddenSources: 1,
    });
  });

  it("is absent without analytics", () => {
    expect(computeProminence({ pages }, config).stats.analytics).toBeNull();
    expect(computeProminence({ pages, analytics: [] }, config).stats.analytics).toBeNull();
  });
});

describe("mapClicks", () => {
  const S = "https://site.test";
  const isInternal = makeInternalTest(`${S}/`, false);

  it("maps analytics URLs through the same policy as the graph", () => {
    const p3 = (u: string) => POLICIES.P3.canonicalise(u, EMPTY_CONTEXT);
    const mapped = mapClicks(
      [
        { sourceUrl: `${S}/a/?utm_source=x`, targetUrl: `${S}/B#top`, clicks: 3 },
        { sourceUrl: "https://other.test/", targetUrl: `${S}/b`, clicks: 1 },
        { sourceUrl: "not a url", targetUrl: `${S}/b`, clicks: 1 },
      ],
      isInternal,
      p3,
    );
    expect(mapped[0]).toEqual({ source: p3(`${S}/a`), target: p3(`${S}/B`), clicks: 3 });
    expect(mapped[0]?.source).toBe(`${S}/a`);
    expect(mapped[1]).toMatchObject({ source: null, reason: "external" });
    expect(mapped[2]).toMatchObject({ source: null, reason: "invalid-url" });
  });
});
