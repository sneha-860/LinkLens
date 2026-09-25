import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { computeProminence, type PageLinks, type ProminenceEdge } from "../prominence/weights.js";
import { refMatrix, type RefMatrix } from "../semantic/ref.js";
import { buildTextModel, type RawDocument } from "../text/model.js";
import { classify, diagnose, type DiagnoseInput, type DiagnosisReport } from "./diagnose.js";

const ALPHA = 0.1;

describe("classify", () => {
  it.each([
    // rho, omega, edge → case
    [0.5, 0, false, "v4"],
    [0.5, 0.05, true, "v3"],
    [0.5, 0.5, true, "v2"],
    [0.05, 0.5, true, "v1"],
    [0.05, 0.05, true, null], // weak and not prominent: none
    [0.05, 0, false, null],
    // boundaries: ρ must exceed α; ω counts as prominent at exactly α
    [ALPHA, 0.5, true, "v1"],
    [ALPHA, 0, false, null],
    [0.5, ALPHA, true, "v2"],
    [ALPHA, ALPHA, true, "v1"],
  ] as const)("ρ=%s ω=%s edge=%s → %s", (rho, omega, edge, expected) => {
    expect(classify(rho, omega, edge, ALPHA)).toBe(expected);
  });
});

// ---------- hand-constructed REF matrix and prominence ----------
const nodes = ["A", "B", "C", "D", "E", "F"];
const entry = (s: string, t: string, ref: number, rho: number) => ({
  source: nodes.indexOf(s),
  target: nodes.indexOf(t),
  ref,
  rho,
  matchedCount: 1,
  matched: [{ term: `${s}${t}`, contribution: ref }],
});
const refM: RefMatrix = {
  version: "ref@1.1.0",
  textVersion: "text@1.0.0",
  runId: 7,
  policyVersion: "P0@1.0.0",
  variant: "weighted",
  epsilon: 0.2,
  explainTerms: 10,
  nodes,
  stats: { nodes: 6, pairs: 30, nonZero: 5, kept: 5, sourcesWithEntries: 2, maxRef: 0.9 },
  entries: [
    entry("A", "B", 0.9, 0.6), // + no link → v4
    entry("A", "C", 0.3, 0.2), // + weak link → v3
    entry("A", "D", 0.3, 0.2), // + strong link → v2
    entry("E", "A", 0.25, 0.08), // ρ ≤ α, strong link → v1
    entry("E", "F", 0.5, 0.92), // no link, ρ > α → v4
  ],
};
const link = (source: string, target: string, omega: number): ProminenceEdge => ({
  source,
  target,
  weight: omega * 10,
  omega,
  origin: "structural",
  structuralWeight: omega * 10,
  clicks: null,
  observations: 1,
  regions: { body: 1 },
});
const prom: DiagnoseInput["prominence"] = {
  version: "prominence@1.0.0",
  runId: 7,
  policyVersion: "P0@1.0.0",
  edges: [
    link("A", "C", 0.05),
    link("A", "D", 0.45),
    link("A", "E", 0.5), // no REF (ρ = 0), ω ≥ α → v1 (flagged, never simulated)
    link("B", "C", 0.04), // no REF, weak link → unclassified
    link("E", "A", 0.96),
    link("E", "E", 0.04), // self-loop: ignored
    link("A", "Z", 0.0), // target without a text document: skipped
  ],
};

describe("diagnose (constructed example)", () => {
  const r = diagnose({ ref: refM, prominence: prom }, { alpha: ALPHA });
  const find = (id: string) => r.diagnoses.find((d) => d.id === id);

  it("reproduces every case", () => {
    expect(find("v4:A->B")).toMatchObject({ label: "missing", rho: 0.6, omega: 0, edge: null });
    expect(find("v3:A->C")).toMatchObject({ label: "buried", rho: 0.2, omega: 0.05 });
    expect(find("v2:A->D")).toMatchObject({ label: "good", rho: 0.2, omega: 0.45 });
    expect(find("v1:E->A")).toMatchObject({
      label: "misleading/low-value",
      rho: 0.08,
      omega: 0.96,
    });
    expect(find("v1:A->E")).toMatchObject({ ref: 0, rho: 0, omega: 0.5, matched: [] });
    expect(find("v4:E->F")).toMatchObject({ rho: 0.92 });
  });

  it("counts each case, the unclassified pairs and the links it cannot judge", () => {
    expect(r.counts).toEqual({
      v4: 2,
      v3: 1,
      v2: 1,
      v1: 2,
      unclassified: 1, // B→C
      skippedNoText: 1, // A→Z
      pairs: 7,
    });
    expect(r.diagnoses).toHaveLength(6);
  });

  it("scores severity as |ω − ρ|", () => {
    expect(find("v4:A->B")?.severity).toBeCloseTo(0.6, 12);
    expect(find("v3:A->C")?.severity).toBeCloseTo(0.15, 12);
    expect(find("v1:E->A")?.severity).toBeCloseTo(0.88, 12);
  });

  it("maps cases to recommendations; v1 is never simulated", () => {
    const byCase = Object.fromEntries(
      r.diagnoses.map((d) => [d.case, [d.recommendation, d.simulate]]),
    );
    expect(byCase).toEqual({
      v4: ["add-link", true],
      v3: ["make-more-visible", true],
      v1: ["flag-for-review", false],
      v2: [null, false],
    });
  });

  it("carries the evidence: REF, the matched n-grams and the existing link", () => {
    expect(find("v3:A->C")).toMatchObject({
      ref: 0.3,
      matched: [{ term: "AC", contribution: 0.3 }],
      edge: { weight: 0.5, observations: 1, origin: "structural", regions: { body: 1 } },
    });
  });

  it("orders by case (v4, v3, v1, v2), then severity", () => {
    expect(r.diagnoses.map((d) => d.id)).toEqual([
      "v4:E->F", // severity 0.92
      "v4:A->B", // 0.6
      "v3:A->C",
      "v1:E->A", // 0.88
      "v1:A->E", // 0.5
      "v2:A->D",
    ]);
  });

  it("records what it was computed from", () => {
    expect(r).toMatchObject({
      version: "diagnosis@1.0.0",
      runId: 7,
      policyVersion: "P0@1.0.0",
      refVersion: "ref@1.1.0",
      refVariant: "weighted",
      prominenceVersion: "prominence@1.0.0",
      alpha: ALPHA,
      epsilon: 0.2,
    });
  });

  it("uses config.alpha", () => {
    const strict = diagnose({ ref: refM, prominence: prom }, { alpha: 0.5 });
    expect(strict.counts).toMatchObject({ v4: 2, v3: 0, v2: 0, v1: 2 });
  });

  it("refuses inputs from different runs or policies", () => {
    expect(() =>
      diagnose({ ref: refM, prominence: { ...prom, runId: 8 } }, { alpha: ALPHA }),
    ).toThrow(/same run and policy/);
    expect(() =>
      diagnose({ ref: refM, prominence: { ...prom, policyVersion: "P3@1.0.0" } }, { alpha: ALPHA }),
    ).toThrow(/same run and policy/);
  });
});

// ---------- the same four cases from pages, through the real text / REF / prominence code ----------
describe("diagnose (from pages)", () => {
  const S = "https://site.test";
  const config = makeConfig({ frequentNgramDropPct: 0 }); // tiny site: keep every term
  const doc = (path: string, title: string, body: string): RawDocument => ({
    node: S + path,
    fetchId: path.length,
    url: S + path,
    title: [title],
    links: [],
    body: [body],
  });
  // The hub covers whales, sharks and turtles, and links to whales (first body link), to cakes
  // (second body link) and to sharks (footer only). It does not link to turtles.
  const docs = [
    doc("/ocean", "Ocean life", "Whale facts. Shark teeth. Turtle nesting."),
    doc("/whale", "Whale facts", "Whale facts."),
    doc("/shark", "Shark teeth", "Shark teeth."),
    doc("/turtle", "Turtle nesting", "Turtle nesting."),
    doc("/cake", "Chocolate cake", "Chocolate cake recipes."),
  ];
  const pages: PageLinks[] = [
    {
      node: `${S}/ocean`,
      links: [
        {
          observationId: 1,
          domRegion: "main",
          templateSignature: null,
          positionIndex: 0,
          target: `${S}/whale`,
        },
        {
          observationId: 2,
          domRegion: "main",
          templateSignature: null,
          positionIndex: 1,
          target: `${S}/cake`,
        },
        {
          observationId: 3,
          domRegion: "footer",
          templateSignature: null,
          positionIndex: 2,
          target: `${S}/shark`,
        },
      ],
    },
    ...docs.slice(1).map((d) => ({ node: d.node, links: [] })),
  ];
  const text = buildTextModel({ runId: 1, policyVersion: "P0@1.0.0", documents: docs }, config);
  const prominence = {
    ...computeProminence({ pages }, config),
    runId: 1,
    policyVersion: "P0@1.0.0",
  };
  const report: DiagnosisReport = diagnose(
    { ref: refMatrix(text, "weighted", config), prominence },
    config,
  );
  const caseOf = (to: string) =>
    report.diagnoses.find((d) => d.source === `${S}/ocean` && d.target === S + to)?.case ?? null;

  it("finds the hub's missing, buried, good and misleading links", () => {
    expect(caseOf("/turtle")).toBe("v4"); // on-topic, not linked
    expect(caseOf("/shark")).toBe("v3"); // on-topic, linked only in the footer
    expect(caseOf("/whale")).toBe("v2"); // on-topic, prominent link
    expect(caseOf("/cake")).toBe("v1"); // off-topic, prominent link
  });

  it("uses ρ = 1/3 for each fully contained leaf and ω from the link weights", () => {
    const total = 1 + 1 / 1.1 + 0.1;
    const d = (to: string) =>
      report.diagnoses.find((x) => x.source === `${S}/ocean` && x.target === S + to);
    expect(d("/turtle")?.rho).toBeCloseTo(1 / 3, 12);
    expect(d("/shark")?.omega).toBeCloseTo(0.1 / total, 12);
    expect(d("/whale")?.omega).toBeCloseTo(1 / total, 12);
    expect(d("/cake")).toMatchObject({ rho: 0, ref: 0 });
    expect(
      d("/whale")
        ?.matched.map((m) => m.term)
        .sort(),
    ).toEqual(["fact", "whale", "whale fact"]);
  });
});
