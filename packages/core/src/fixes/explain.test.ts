import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { diagnose } from "../diagnosis/diagnose.js";
import { computeProminence, type PageLinks } from "../prominence/weights.js";
import { refMatrix } from "../semantic/ref.js";
import { buildTextModel, type RawDocument } from "../text/model.js";
import {
  explainAll,
  explainFix,
  f2,
  pct,
  sci,
  shortUrl,
  targetNeeds,
  type ExplainInput,
  type FixExplanationInput,
} from "./explain.js";
import type { RescuedOrphan } from "./rescue.js";
import type { FixRecord } from "./scoring.js";

const S = "https://site.test";
const config = makeConfig({ frequentNgramDropPct: 0 });

describe("formatting", () => {
  it("is fixed and locale-free", () => {
    expect(shortUrl(`${S}/blog/post?page=2`)).toBe("/blog/post?page=2");
    expect(shortUrl(S)).toBe("/");
    expect(f2(0.12345)).toBe("0.12");
    expect(sci(0.00123456)).toBe("1.23e-3");
    expect(sci(0.00123456, true)).toBe("+1.23e-3");
    expect(sci(-0.0005, true)).toBe("-5.00e-4");
    expect(pct(34.567)).toBe("+34.6%");
    expect(pct(-2)).toBe("-2.0%");
  });
});

// ---------- the diagnosis example: an ocean hub, three animal pages and a cake page ----------
const doc = (path: string, title: string, body: string): RawDocument => ({
  node: S + path,
  fetchId: path.length,
  url: S + path,
  title: [title],
  links: [],
  body: [body],
});
const docs = [
  doc("/ocean", "Ocean life", "Whale facts. Shark teeth. Turtle nesting."),
  doc("/whale", "Whale facts", "Whale facts."),
  doc("/shark", "Shark teeth", "Shark teeth."),
  doc("/turtle", "Turtle nesting", "Turtle nesting."),
  doc("/cake", "Chocolate cake", "Chocolate cake recipes."),
];
const link = (id: number, region: string, pos: number, to: string) => ({
  observationId: id,
  domRegion: region,
  templateSignature: null,
  positionIndex: pos,
  target: S + to,
});
const pages: PageLinks[] = [
  {
    node: `${S}/ocean`,
    links: [
      link(1, "main", 0, "/whale"),
      link(2, "main", 1, "/cake"),
      link(3, "footer", 2, "/shark"),
    ],
  },
  ...docs.slice(1).map((d) => ({ node: d.node, links: [] })),
];
const text = buildTextModel({ runId: 1, policyVersion: "P0@1.0.0", documents: docs }, config);
const ref = refMatrix(text, "weighted", config);
const prominence = { ...computeProminence({ pages }, config), runId: 1, policyVersion: "P0@1.0.0" };
const { diagnoses } = diagnose({ ref, prominence }, config);
const entry = (u: string, v: string) =>
  ref.entries.find((e) => ref.nodes[e.source] === u && ref.nodes[e.target] === v);

/** A fix record as the ranking would produce it (numbers chosen, not simulated). */
const fix = (
  to: string,
  type: FixRecord["type"],
  pr: [number, number],
  depth: [number | null, number | null],
  rank: number,
): FixRecord => {
  const e = entry(`${S}/ocean`, S + to);
  return {
    id: `${type}:${S}/ocean->${S}${to}`,
    donor: `${S}/ocean`,
    target: S + to,
    type,
    prBefore: pr[0],
    prAfter: pr[1],
    deltaPr: pr[1] - pr[0],
    deltaPrL1: 2 * (pr[1] - pr[0]),
    deltaDepth: depth[0] === null || depth[1] === null ? null : depth[1] - depth[0],
    depthBefore: depth[0],
    depthAfter: depth[1],
    sigmaVariant: "refGateCosine",
    sigma: 0.8,
    sigmas: { cosineOnly: 0.8, refOnly: e?.ref ?? 0, refGateCosine: 0.8, blended: 0.9 },
    ref: e?.ref ?? 0,
    rho: e?.rho ?? 0,
    cosine: 0.8,
    prominence: { omega: null, weightBefore: 0, weightAfter: 1 },
    kappa: 1,
    templateReach: 1,
    score: (pr[1] - pr[0]) * 0.8,
    rank,
    targetRank: 1,
    targetReasons: [],
    diagnosis: null,
    policyVersion: "P0@1.0.0",
  };
};
const rescue: RescuedOrphan = {
  node: `${S}/whale-songs`,
  urls: [`${S}/whale-songs`],
  channels: ["xml_sitemap"],
  revealedBy: ["xml_sitemap"],
  sources: { xml_sitemap: [`${S}/sitemap.xml`] },
  status: "scored",
  fetch: null,
  shortlisted: 1,
  rejected: { unreachable: 0, utility: 0, section: 0, "ref-not-above-epsilon": 3, capped: 0 },
  donors: [
    {
      rank: 1,
      donor: `${S}/whale`,
      ref: 0.61,
      refRank: 1,
      matched: [
        { term: "whale", contribution: 0.3 },
        { term: "fact", contribution: 0.2 },
        { term: "whale fact", contribution: 0.11 },
      ],
      prBefore: 0.02,
      prAfter: 0.05,
      deltaPr: 0.03,
      deltaPrL1: 0.06,
      depthAfter: 2,
      reasons: [],
    },
  ],
};
const input: ExplainInput = {
  fixes: [
    fix("/turtle", "add-link", [0.1, 0.13], [2, 1], 1), // v4: missing
    fix("/shark", "make-visible", [0.08, 0.1], [1, 1], 2), // v3: footer link
  ],
  rescues: [rescue],
  diagnoses,
  issues: [
    { type: "deep-page", node: `${S}/turtle`, evidence: { depth: 5, threshold: 3 } },
    {
      type: "weak-authority",
      node: `${S}/turtle`,
      evidence: { pagerank: 0.0012, percentile: 20, threshold: 0.0018 },
    },
    { type: "orphan", node: `${S}/whale-songs`, evidence: { channels: ["xml_sitemap"] } },
  ],
  matched: (u, v) => entry(u, v)?.matched ?? [],
  edges: prominence.edges,
  effort: new Map([
    [`${S}/ocean`, { kappa: 2, templateReach: 4 }],
    [`${S}/whale`, { kappa: 1, templateReach: 1 }],
  ]),
  alpha: config.alpha,
  epsilon: config.epsilon,
  explainTerms: config.explainTerms,
};
const all = explainAll(input);

describe("fix explanations", () => {
  it("explain an added link to a deep, weak, missing target", () => {
    const e = all.fixes[0];
    expect(e?.sentence).toMatchInlineSnapshot(
      `"Add a link from /ocean to /turtle: the target is 5 clicks from the home page (deeper than 3); REF 1.00 on 'nest', 'turtl'; predicted PageRank +3.00e-2 (+30.0%); κ 2."`,
    );
    expect(e?.lines).toMatchInlineSnapshot(`
      [
        "Why the target: /turtle is 5 clicks from the home page (deeper than 3); is in the bottom 20% by PageRank (1.20e-3 < 1.80e-3); is missing a link from 1 related page (v4).",
        "Why this donor: REF(u,v) 1.00 > ε 0.2, on 'nest', 'turtl', 'turtl nest'; cosine 0.80.",
        "There is no link from /ocean to /turtle yet.",
        "Predicted: PageRank +3.00e-2 (+30.0%); /turtle goes from 2 to 1 click deep (-1).",
        "Effort: κ 2 (2 body link blocks); its widest body block is a template on 4 pages.",
        "Case: v4 (missing).",
      ]
    `);
  });

  it("explain making a footer link visible", () => {
    const e = all.fixes[1];
    expect(e?.sentence).toMatchInlineSnapshot(
      `"Make the link from /ocean to /shark more visible: the target is buried: 1 related page links to it only faintly (v3); REF 1.00 on 'shark', 'shark teeth'; predicted PageRank +2.00e-2 (+25.0%); κ 2."`,
    );
    expect(e?.lines).toMatchInlineSnapshot(`
      [
        "Why the target: /shark is buried: 1 related page links to it only faintly (v3).",
        "Why this donor: REF(u,v) 1.00 > ε 0.2, on 'shark', 'shark teeth', 'teeth'; cosine 0.80.",
        "/ocean already links to /shark from the footer, with low prominence ω 0.05 (< α 0.1).",
        "Predicted: PageRank +2.00e-2 (+25.0%); /shark stays 1 click deep.",
        "Effort: κ 2 (2 body link blocks); its widest body block is a template on 4 pages.",
        "Case: v3 (buried).",
      ]
    `);
  });

  it("explain an orphan rescue (found only via the XML sitemap)", () => {
    expect(all.rescues[0]?.sentence).toMatchInlineSnapshot(
      `"Add a link from /whale to /whale-songs: the target is linked from nowhere and was found only via the XML sitemap; REF 0.61 on 'whale', 'fact'; predicted PageRank +3.00e-2 (+150.0%); κ 1."`,
    );
    expect(all.rescues[0]?.lines).toMatchInlineSnapshot(`
      [
        "Why the target: /whale-songs is linked from nowhere and was found only via the XML sitemap.",
        "Why this donor: REF(u,v) 0.61 > ε 0.2, on 'whale', 'fact', 'whale fact'; no embedding cosine.",
        "There is no link from /whale to /whale-songs yet.",
        "Predicted: PageRank +3.00e-2 (+150.0%); /whale-songs becomes reachable, 2 clicks from the home page.",
        "Effort: κ 1 (1 body link block); its body blocks are unique to the page.",
        "Case: orphan rescue (not diagnosed: the orphan has no link to judge).",
      ]
    `);
  });

  it("carry the structured fields", () => {
    expect(all.fixes[0]).toMatchObject({
      kind: "fix",
      type: "add-link",
      needs: [
        { kind: "deep-page", depth: 5, threshold: 3 },
        { kind: "weak-authority", percentile: 20 },
        { kind: "v4", from: 1 },
      ],
      link: { exists: false, omega: null },
      impact: { prBefore: 0.1, prAfter: 0.13, depthBefore: 2, depthAfter: 1, deltaDepth: -1 },
      effort: { kappa: 2, templateReach: 4 },
      case: { label: "v4" },
      rank: 1,
    });
    expect(all.fixes[0]?.impact.deltaPrPct).toBeCloseTo(30, 10);
    expect(all.fixes[0]?.donorEvidence.matched.map((m) => m.term)).toEqual([
      "nest",
      "turtl",
      "turtl nest",
    ]);
    expect(all.fixes[1]).toMatchObject({
      link: { exists: true, regions: { footer: 1 } },
      case: { label: "v3" },
    });
    expect(all.rescues[0]).toMatchObject({
      kind: "rescue",
      donorEvidence: { cosine: null },
      case: { label: null },
    });
  });
});

describe("diagnosis explanations", () => {
  const of = (c: string, to: string) =>
    all.diagnoses.find((d) => d.case === c && d.source === `${S}/ocean` && d.target === S + to);

  it("explain each case", () => {
    expect(of("v4", "/turtle")?.sentence).toMatchInlineSnapshot(
      `"/ocean → /turtle is missing (v4): /ocean covers /turtle's topic (ρ 0.33 > α 0.1; REF 1.00 on 'nest', 'turtl', 'turtl nest') but does not link to it. Recommendation: add a link (severity 0.33)."`,
    );
    expect(of("v3", "/shark")?.sentence).toMatchInlineSnapshot(
      `"/ocean → /shark is buried (v3): /ocean covers /shark's topic (ρ 0.33 > α 0.1; REF 1.00 on 'shark', 'shark teeth', 'teeth') but links to it only from the footer with ω 0.05 < α 0.1. Recommendation: make the link more visible (severity 0.28)."`,
    );
    expect(of("v2", "/whale")?.sentence).toMatchInlineSnapshot(
      `"/ocean → /whale is good (v2): /ocean covers /whale's topic (ρ 0.33 > α 0.1; REF 1.00 on 'fact', 'whale', 'whale fact') and links to it prominently from the main content (ω 0.50 ≥ α 0.1). No action needed."`,
    );
    expect(of("v1", "/cake")?.sentence).toMatchInlineSnapshot(
      `"/ocean → /cake is misleading or low-value (v1): it links prominently from the main content (ω 0.45 ≥ α 0.1) but the pages are not related (ρ 0.00 ≤ α 0.1; REF 0.00). Recommendation: flag for review or removal (never simulated; severity 0.45)."`,
    );
  });

  it("explain every diagnosis", () => {
    expect(all.diagnoses).toHaveLength(diagnoses.length);
    expect(all.diagnoses.map((d) => d.id)).toEqual(diagnoses.map((d) => d.id));
  });
});

describe("edge cases", () => {
  const base: FixExplanationInput = {
    kind: "fix",
    id: "x",
    donor: `${S}/a`,
    target: `${S}/b`,
    type: "add-link",
    ref: 0.5,
    rho: 0.05,
    cosine: null,
    matched: [],
    edge: null,
    prBefore: 0,
    prAfter: 0.01,
    deltaPr: 0.01,
    depthBefore: null,
    depthAfter: 3,
    deltaDepth: null,
    effort: { kappa: 3, templateReach: 12 },
    needs: [],
    diagnosis: null,
    alpha: 0.1,
    epsilon: 0.2,
    score: 0.001,
    rank: 7,
    explainTerms: 5,
  };

  it("handle PR 0 before, a page becoming reachable, a template donor and no target need", () => {
    const e = explainFix(base);
    expect(e.impact.deltaPrPct).toBeNull();
    expect(e.lines).toMatchInlineSnapshot(`
      [
        "Why the target: /b is a fix target.",
        "Why this donor: REF(u,v) 0.50 > ε 0.2; no embedding cosine.",
        "There is no link from /a to /b yet.",
        "Predicted: PageRank +1.00e-2; /b becomes reachable, 3 clicks from the home page.",
        "Effort: κ 3 (3 body link blocks); its widest body block is a template on 12 pages.",
        "Case: not one of the four cases (ρ 0.05 ≤ α 0.1).",
      ]
    `);
  });

  it("describe a link that exists only in the navigation", () => {
    const e = explainFix({ ...base, edge: { omega: 0.3, regions: { nav: 2 } } });
    expect(e.lines[2]).toMatchInlineSnapshot(
      `"/a links to /b only from the navigation (ω 0.30); a link in the main content is missing."`,
    );
  });

  it("list target needs in a fixed order", () => {
    const needs = targetNeeds(
      "t",
      [
        {
          type: "weak-authority",
          node: "t",
          evidence: { pagerank: 1, percentile: 20, threshold: 2 },
        },
        { type: "orphan", node: "t", evidence: { channels: ["link_graph", "feed", "llms_txt"] } },
        { type: "dead-end", node: "t", evidence: {} },
      ],
      [{ case: "v3", target: "t" }],
    );
    expect(needs.map((n) => n.kind)).toEqual(["orphan", "weak-authority", "v3"]);
    expect(needs[0]).toEqual({ kind: "orphan", revealedBy: ["feed", "llms_txt"] });
  });
});

describe("determinism", () => {
  it("gives byte-identical output for the same input", () => {
    expect(JSON.stringify(explainAll(input))).toBe(JSON.stringify(all));
  });

  it("matches the stored snapshot of every explanation", () => {
    expect(all).toMatchSnapshot();
  });
});
