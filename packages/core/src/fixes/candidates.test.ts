import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import type { ProminenceEdge } from "../prominence/weights.js";
import type { RefMatrix } from "../semantic/ref.js";
import {
  candidateTargets,
  generateCandidates,
  sectionOf,
  sectionRelation,
  utilityMatcher,
  type CandidateInput,
} from "./candidates.js";

const S = "https://s.test";
const config = makeConfig();

describe("sectionOf", () => {
  it.each([
    ["/", ""],
    ["/about", ""],
    ["/blog", ""],
    ["/blog/", "blog"],
    ["/blog/post", "blog"],
    ["/a/b/c", "a"],
    ["/blog/post?page=2", "blog"],
  ])("%s → %j", (path, section) => {
    expect(sectionOf(S + path)).toBe(section);
  });
});

describe("sectionRelation", () => {
  it("allows the same section, configured siblings and top-level pages; blocks the rest", () => {
    expect(sectionRelation("blog", "blog", config)).toBe("same");
    expect(sectionRelation("", "blog", config)).toBe("top-level");
    expect(sectionRelation("blog", "", config)).toBe("top-level");
    expect(sectionRelation("news", "blog", config)).toBeNull();
    const siblings = { ...config, candidateSiblingSections: [["blog", "news"]] };
    expect(sectionRelation("news", "blog", siblings)).toBe("sibling");
    expect(sectionRelation("shop", "blog", siblings)).toBeNull();
    expect(
      sectionRelation("", "blog", { ...config, candidateTopLevelIsSibling: false }),
    ).toBeNull();
    expect(sectionRelation("shop", "blog", { ...config, candidateSectionBlocking: false })).toBe(
      "unblocked",
    );
  });
});

describe("utilityMatcher (default patterns)", () => {
  const isUtility = utilityMatcher(config.candidateUtilityPatterns);
  it.each([
    "/login",
    "/sign-in/",
    "/logout",
    "/register.php",
    "/account/orders",
    "/my-account",
    "/profile",
    "/cart",
    "/checkout.html",
    "/search",
    "/search/whales",
    "/?s=whale",
    "/blog?q=whale",
    "/tag/whales",
    "/tags/whales/",
    "/blog/tag/whales/",
  ])("%s is a utility page", (path) => {
    expect(isUtility(S + path)).not.toBeNull();
  });
  it.each([
    "/",
    "/blog/cartography",
    "/blogin",
    "/accountant-services",
    "/research",
    "/vintage/",
    "/blog/login-tips-for-whales",
    "/blog/post?page=2",
  ])("%s is not", (path) => {
    expect(isUtility(S + path)).toBeNull();
  });
});

describe("candidateTargets", () => {
  it("takes orphans, deep pages, weak-authority pages and v4/v3 targets, merging reasons", () => {
    const t = candidateTargets(
      [
        { type: "orphan", node: "O" },
        { type: "deep-page", node: "D" },
        { type: "weak-authority", node: "D" },
        { type: "dead-end", node: "X" },
        { type: "outside-largest-scc", node: "Y" },
      ],
      [
        { case: "v4", target: "D" },
        { case: "v3", target: "B" },
        { case: "v1", target: "Z" },
        { case: "v2", target: "G" },
      ],
    );
    expect(Object.fromEntries([...t].map(([k, v]) => [k, [...v]]))).toEqual({
      O: ["orphan"],
      D: ["deep-page", "weak-authority", "v4"],
      B: ["v3"],
    });
  });
});

// ---------- one target, one donor per rule ----------
const T = "/blog/t";
const nodes = [
  "/",
  "/blog/a",
  "/blog/b",
  "/blog/c",
  "/blog/d",
  "/blog/e",
  T,
  "/news/x",
  "/shop/y",
  "/login",
  "/tag/whales/",
  "/search?q=whales",
].map((p) => S + p);
const REFS: [string, number][] = [
  ["/", 0.5], // top-level donor → add-link
  ["/blog/a", 0.6], // same section, no link → add-link (diagnosed v4)
  ["/blog/b", 0.3], // body link with ω 0.05 < α → make-visible
  ["/blog/c", 0.4], // body link with ω 0.5 ≥ α → rejected: prominent-link
  ["/blog/d", 0.2], // REF = ε → rejected (REF must exceed ε)
  ["/blog/e", 0.45], // linked only from the nav → add-link
  ["/news/x", 0.7], // other section → rejected: section
  ["/shop/y", 0.15], // other section → rejected: section (checked before REF)
  ["/login", 0.9], // utility → rejected
  ["/tag/whales/", 0.9], // utility (tag archive) → rejected
  ["/search?q=whales", 0.9], // utility → rejected
];
const ref: RefMatrix = {
  version: "ref@1.1.0",
  textVersion: "text@1.0.0",
  runId: 1,
  policyVersion: "P0@1.0.0",
  variant: "weighted",
  epsilon: 0.2,
  explainTerms: 10,
  nodes,
  stats: { nodes: nodes.length, pairs: 0, nonZero: 0, kept: 0, sourcesWithEntries: 0, maxRef: 0.9 },
  entries: REFS.map(([p, r]) => ({
    source: nodes.indexOf(S + p),
    target: nodes.indexOf(S + T),
    ref: r,
    rho: r / 2,
    matchedCount: 1,
    matched: [],
  })),
};
const edge = (from: string, omega: number, regions: ProminenceEdge["regions"]): ProminenceEdge => ({
  source: S + from,
  target: S + T,
  weight: omega,
  omega,
  origin: "structural",
  structuralWeight: omega,
  clicks: null,
  observations: 1,
  regions,
});
const input = (targets: [string, string[]][] = [[T, ["deep-page", "v4"]]]): CandidateInput => ({
  targets: new Map(targets.map(([p, r]) => [S + p, new Set(r as never[])])),
  ref,
  edges: [
    edge("/blog/b", 0.05, { body: 1 }),
    edge("/blog/c", 0.5, { body: 1 }),
    edge("/blog/e", 0.5, { nav: 1 }),
  ],
  diagnoses: [{ case: "v4", source: `${S}/blog/a`, target: S + T }],
});

describe("generateCandidates", () => {
  const out = generateCandidates(
    input([
      [T, ["deep-page", "v4"]],
      ["/blog/lost", ["orphan"]],
    ]),
    config,
  );
  const forT = out.candidates.filter((c) => c.target === S + T);
  const by = (p: string) => forT.find((c) => c.donor === S + p);

  it("admits exactly the donors that pass every rule, ranked by REF", () => {
    expect(forT.map((c) => [c.donor.replace(S, ""), c.action, c.rank])).toEqual([
      ["/blog/a", "add-link", 1],
      ["/", "add-link", 2],
      ["/blog/e", "add-link", 3],
      ["/blog/b", "make-visible", 4],
    ]);
  });

  it("counts each rejected donor under the first rule it failed", () => {
    expect(out.targets.find((t) => t.node === S + T)).toEqual({
      node: S + T,
      reasons: ["deep-page", "v4"],
      hasText: true,
      admitted: 4,
      kept: 4,
      rejected: {
        self: 1,
        utility: 3,
        section: 2,
        "ref-not-above-epsilon": 1,
        "prominent-link": 1,
        capped: 0,
      },
    });
  });

  it("explains why each candidate was admitted", () => {
    expect(by("/blog/a")?.reasons).toEqual([
      "target: deep-page, v4",
      "donor is a same-site HTML page with text",
      "donor is not a utility page",
      "same section ('blog')",
      "REF(u,v) = 0.6 > ε = 0.2",
      "no link u→v yet: add a body link",
      "diagnosed v4 (missing) for this pair",
    ]);
    expect(by("/")?.reasons[3]).toBe("donor is a top-level page (top level → 'blog')");
    expect(by("/blog/e")?.reasons[5]).toBe("linked only from nav: add a body link");
    expect(by("/blog/b")?.reasons[5]).toBe(
      "body link with low prominence ω = 0.05 < α = 0.1: make it more visible",
    );
  });

  it("carries the evidence: REF, ρ, the existing link, sections, the pair's diagnosis", () => {
    expect(by("/blog/b")).toMatchObject({
      id: `make-visible:${S}/blog/b->${S}${T}`,
      ref: 0.3,
      rho: 0.15,
      existingLink: { omega: 0.05, bodyLink: true, regions: { body: 1 } },
      diagnosis: null,
      section: { donor: "blog", target: "blog", relation: "same" },
      targetReasons: ["deep-page", "v4"],
    });
    expect(by("/blog/e")?.existingLink).toEqual({
      omega: 0.5,
      bodyLink: false,
      regions: { nav: 1 },
    });
    expect(by("/blog/a")?.diagnosis).toBe("v4");
  });

  it("reports a target without text (e.g. an orphan never crawled) with no candidates", () => {
    expect(out.targets.find((t) => t.node === `${S}/blog/lost`)).toMatchObject({
      reasons: ["orphan"],
      hasText: false,
      admitted: 0,
      kept: 0,
    });
    expect(out.stats).toMatchObject({
      targets: 2,
      targetsWithoutText: 1,
      candidates: 4,
      byAction: { "add-link": 3, "make-visible": 1 },
      targetsByReason: { orphan: 1, "deep-page": 1, "weak-authority": 0, v4: 1, v3: 0 },
    });
  });

  it("caps candidates per target by REF and counts the rest as capped", () => {
    const capped = generateCandidates(input(), { ...config, candidateMaxPerTarget: 2 });
    expect(capped.candidates.map((c) => c.donor.replace(S, ""))).toEqual(["/blog/a", "/"]);
    expect(capped.targets[0]).toMatchObject({ admitted: 4, kept: 2, rejected: { capped: 2 } });
  });

  it("admits sibling sections when configured, and everything when blocking is off", () => {
    const siblings = generateCandidates(input(), {
      ...config,
      candidateSiblingSections: [["blog", "news"]],
    });
    expect(siblings.candidates[0]).toMatchObject({
      donor: `${S}/news/x`,
      section: { relation: "sibling" },
    });
    const open = generateCandidates(input(), { ...config, candidateSectionBlocking: false });
    const donors = open.candidates.map((c) => c.donor.replace(S, ""));
    expect(donors).toContain("/news/x");
    expect(donors).not.toContain("/shop/y"); // now fails on REF (0.15 ≤ ε) instead
    expect(open.targets[0]?.rejected).toMatchObject({ section: 0, "ref-not-above-epsilon": 2 });
  });

  it("uses the configured utility patterns and α", () => {
    const noUtility = generateCandidates(input(), { ...config, candidateUtilityPatterns: [] });
    expect(noUtility.candidates.slice(0, 2).map((c) => c.donor.replace(S, ""))).toEqual([
      "/login",
      "/search?q=whales",
    ]);
    // With α = 0.6 the body link from /blog/c (ω 0.5) is no longer prominent: make-visible.
    const strict = generateCandidates(input(), { ...config, alpha: 0.6 });
    expect(strict.candidates.find((c) => c.donor === `${S}/blog/c`)?.action).toBe("make-visible");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(generateCandidates(input(), config))).toBe(
      JSON.stringify(generateCandidates(input(), config)),
    );
  });
});
