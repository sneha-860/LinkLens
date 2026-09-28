import { describe, expect, it } from "vitest";
import { canonicalise, makeConfig, type LinkLensConfig, type db as q } from "@linklens/core";
import {
  auc,
  editorialSite,
  maskingRecovery,
  maskSite,
  rankMasked,
  rankOf,
  recallAt,
  reciprocalRank,
  stripAnchors,
  summariseRepeats,
  type MaskedSite,
} from "./e6-masking.js";
import type { RunInputs } from "./in-memory.js";
import { hashingEmbedder } from "./sizes.js";

const S = "https://s.test";

describe("rank statistics (ties broken at random, in expectation)", () => {
  it("a clear winner", () => {
    const r = rankOf([0.9, 0.5, 0.1], 0);
    expect(r).toEqual({ above: 0, tied: 1, candidates: 3 });
    expect(recallAt(r, 1)).toBe(1);
    expect(reciprocalRank(r)).toBe(1);
    expect(auc(r)).toBe(1);
  });

  it("ties share the ranks they span", () => {
    // Relevant (index 1) ties with one other, one candidate above: rank 2 or 3.
    const r = rankOf([0.9, 0.5, 0.5, 0.1], 1);
    expect(r).toEqual({ above: 1, tied: 2, candidates: 4 });
    expect(recallAt(r, 1)).toBe(0);
    expect(recallAt(r, 2)).toBe(0.5);
    expect(recallAt(r, 3)).toBe(1);
    expect(reciprocalRank(r)).toBeCloseTo((1 / 2 + 1 / 3) / 2);
    expect(auc(r)).toBeCloseTo((1 + 0.5) / 3);
  });

  it("all tied is the random baseline: recall k/N, MRR H_N/N, AUC ½", () => {
    const r = rankOf([0, 0, 0, 0], 2);
    expect(recallAt(r, 1)).toBe(0.25);
    expect(reciprocalRank(r)).toBeCloseTo((1 + 1 / 2 + 1 / 3 + 1 / 4) / 4);
    expect(auc(r)).toBe(0.5);
    expect(auc(rankOf([1], 0))).toBeNull();
  });
});

describe("stripAnchors", () => {
  it("removes the first occurrence of each anchor", () => {
    expect(stripAnchors("Whale song. More whale song.", ["whale song", "Whale song"])).toBe(
      ". More .",
    );
    expect(stripAnchors("text", ["", "  "])).toBe("text");
    // Case differs (e.g. at the start of a sentence): matched without case.
    expect(stripAnchors("Shark teeth regrow.", ["shark teeth"])).toBe(" regrow.");
  });
});

// ---------- a small site ----------

let id = 1;
type Link = [to: string, anchor: string, region: string, template: string];
function site(
  pages: Record<string, { body: string; links: Link[] }>,
  over: Partial<LinkLensConfig> = {},
): RunInputs {
  const pageRows: q.PageRow[] = [];
  const linkRows: q.LinkObservationRow[] = [];
  for (const [path, p] of Object.entries(pages)) {
    const fetchId = id++;
    pageRows.push({
      fetchId,
      url: S + path,
      title: path.slice(1) || "home",
      h1: null,
      bodyText: p.body,
    } as q.PageRow);
    p.links.forEach(([to, anchor, region, template], i) =>
      linkRows.push({
        id: id++,
        runId: 1,
        sourceFetchId: fetchId,
        rawHref: to,
        resolvedUrl: S + to,
        anchorText: anchor,
        rel: null,
        domRegion: region,
        domPath: null,
        templateSignature: template,
        positionIndex: i,
      }),
    );
  }
  return {
    runId: 1,
    startedAt: new Date(0),
    config: makeConfig({ frequentNgramDropPct: 0, ...over }),
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
    fetches: [],
    discovery: [],
    cosine: null,
  };
}

// Three editorial links (whale → whale-song, shark → shark-teeth, reef → turtle), a nav from the
// home page, and a "back home" link in the same block on every page (site-wide: not editorial).
const home: Link = ["/", "home", "main", "back-home"];
const PAGES = {
  "/": {
    body: "Ocean guide.",
    links: [
      ["/whale", "whales", "nav", "nav"],
      ["/shark", "sharks", "nav", "nav"],
      ["/reef", "reefs", "nav", "nav"],
    ] as Link[],
  },
  "/whale": {
    body: "Humpback whale song carries far; humpback whales sing at sea.",
    links: [["/whale-song", "whale song", "main", "w"], home] as Link[],
  },
  "/whale-song": { body: "Whale song is sung by humpback whales.", links: [home] },
  "/shark": {
    body: "Shark teeth regrow quickly; sharks replace teeth often.",
    links: [["/shark-teeth", "shark teeth", "main", "s"], home] as Link[],
  },
  "/shark-teeth": { body: "Shark teeth are replaced often.", links: [home] },
  "/reef": {
    body: "Coral reef fish shelter near sea turtles; turtles nest on beaches.",
    links: [["/turtle", "turtles", "main", "r"], home] as Link[],
  },
  "/turtle": { body: "Sea turtles nest on beaches.", links: [home] },
};

const prepared = (inputs: RunInputs) => editorialSite(inputs, "P3");
const eligibleOf = (inputs: RunInputs) =>
  prepared(inputs).eligible.map((x) => `${x.donor.slice(S.length)} -> ${x.target.slice(S.length)}`);

describe("maskSite", () => {
  const inputs = site(PAGES);

  it("only editorial body links between pages with text can be masked (not nav, not site-wide)", () => {
    expect(eligibleOf(inputs)).toEqual([
      "/reef -> /turtle",
      "/shark -> /shark-teeth",
      "/whale -> /whale-song",
    ]);
  });

  it("masks a seeded share, removing the link and its anchor from Links and body", () => {
    const s = prepared(inputs);
    const a = maskSite(inputs, s, 7, inputs.config);
    expect(maskSite(inputs, s, 7, inputs.config)).toEqual(a); // deterministic
    expect(a.share).toBeGreaterThanOrEqual(0.1);
    expect(a.share).toBeLessThanOrEqual(0.2);
    expect(a.masked).toHaveLength(1); // at least one of three
    const { donor, target } = a.masked[0] as MaskedSite["masked"][number];
    expect(a.graph.hasDirectedEdge(donor, target)).toBe(false);
    const doc = a.documents.find((d) => d.node === donor);
    const anchor = {
      [`${S}/whale`]: "whale song",
      [`${S}/shark`]: "shark teeth",
      [`${S}/reef`]: "turtles",
    }[donor] as string;
    expect(doc?.links).not.toContain(anchor);
    // The link's own occurrence leaves the body (other mentions of the words stay).
    const count = (t: string) => t.toLowerCase().split(anchor).length - 1;
    const kept = maskSite(inputs, s, 7, { ...inputs.config, e6StripAnchorsFromBody: false });
    const before = count(kept.documents.find((d) => d.node === donor)?.body.join(" ") ?? "");
    expect(before).toBeGreaterThan(0); // without stripping, the answer leaks through the body
    expect(count(doc?.body.join(" ") ?? "")).toBe(before - 1);
  });
});

describe("rankMasked", () => {
  const inputs = site(PAGES);
  const s = prepared(inputs);
  // Mask all three editorial links.
  const m = maskSite(inputs, s, 1, { ...inputs.config, e6MaskShareMin: 1, e6MaskShareMax: 1 });
  // Topic vectors: whale pages, shark pages, reef/turtle pages, and the home page.
  const topic = (n: string) =>
    /whale/.test(n)
      ? [1, 0, 0]
      : /shark/.test(n)
        ? [0, 1, 0]
        : /reef|turtle/.test(n)
          ? [0, 0, 1]
          : [0.5, 0.5, 0.5];
  const vector = (n: string) => {
    const v = topic(n);
    const norm = Math.hypot(...v);
    return Float32Array.from(v.map((x) => x / norm));
  };
  const r = rankMasked(m, vector, 1, "P3@1.0.0", inputs.config);

  it("makes one query per masked edge", () => {
    expect(r).toMatchObject({ targets: 3, queries: 3 });
  });

  it("the topical donor ranks first by every semantic method; random is its expectation", () => {
    for (const method of ["ref", "cosine", "jaccard", "refGateCosine", "blended"] as const) {
      expect(r.methods[method]?.mrr).toBe(1);
      expect(r.methods[method]?.recall[5]).toBe(1);
      expect(r.methods[method]?.auc).toBe(1);
    }
    const random = r.methods.random;
    expect(random?.auc).toBe(0.5);
    // 6 candidates per query (every page with text but the target): recall@5 is 5/6 in
    // expectation, recall@20 is 1, and the expected MRR is H_6 / 6.
    expect(random?.recall[5]).toBeCloseTo(5 / 6);
    expect(random?.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5 + 1 / 6) / 6);
    expect(random?.recall[20]).toBe(1);
    expect(random?.mrr).toBeLessThan(1);
  });

  it("extra ε gates: at the config's ε the gated hybrid is the hybrid itself", () => {
    const g = rankMasked(m, vector, 1, "P3@1.0.0", inputs.config, [inputs.config.epsilon, 0.99]);
    expect(g.gated?.[String(inputs.config.epsilon)]).toEqual(g.methods.refGateCosine);
    expect(g.gated?.["0.99"]?.mrr).toBeCloseTo(g.methods.random?.mrr as number, 12);
    expect(r.gated).toBeUndefined(); // only when asked for
  });

  it("the hybrid gates cosine by REF > ε: with nothing above ε it is the random baseline", () => {
    const gated = rankMasked(m, vector, 1, "P3@1.0.0", { ...inputs.config, epsilon: 0.99 });
    expect(gated.methods.refGateCosine?.mrr).toBeCloseTo(gated.methods.random?.mrr as number, 12);
    expect(gated.methods.cosine?.mrr).toBe(1); // cosine alone is unaffected
  });

  it("graph baselines can be switched off", () => {
    const off = rankMasked(m, vector, 1, "P3@1.0.0", { ...inputs.config, e6GraphBaselines: false });
    expect(Object.keys(off.methods)).not.toContain("adamicAdar");
    expect(Object.keys(r.methods)).toContain("commonNeighbours");
  });
});

describe("summariseRepeats and maskingRecovery", () => {
  it("averages each method over the repeats", () => {
    const rep = (mrr: number) => ({
      repeat: 0,
      seed: 0,
      share: 0.1,
      eligiblePairs: 3,
      masked: 1,
      targets: 1,
      queries: 1,
      methods: { cosine: { queries: 1, recall: { 5: mrr }, mrr, auc: mrr } },
    });
    const s = summariseRepeats([rep(1), rep(0.5)], [5]);
    expect(s.cosine).toEqual({ queries: 2, recall: { 5: 0.75 }, mrr: 0.75, auc: 0.75 });
  });

  it("runs every repeat with the embedder, deterministically", async () => {
    const inputs = site(PAGES, { e6Repeats: 3 });
    const embedder = hashingEmbedder({
      model: inputs.config.embeddingModel,
      dtype: inputs.config.embeddingDtype,
      bodyTokens: inputs.config.embeddingBodyTokens,
      batchSize: 8,
      cacheDir: "unused",
    });
    const a = await maskingRecovery(inputs, "P3", embedder, 42);
    expect(a.repeats.map((x) => x.seed)).toEqual([42, 43, 44]);
    expect(a.options).toMatchObject({ repeats: 3, ks: [5, 10, 20], stripAnchorsFromBody: true });
    expect(a.summary.ref?.queries).toBe(3);
    expect(await maskingRecovery(inputs, "P3", embedder, 42)).toEqual(a);
    await expect(
      maskingRecovery(
        inputs,
        "P3",
        { ...embedder, options: { ...embedder.options, model: "other" } },
        42,
      ),
    ).rejects.toThrow(/does not match/);
  });
});
