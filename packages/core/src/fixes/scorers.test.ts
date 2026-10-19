import { describe, expect, it } from "vitest";
import {
  FEATURES,
  STRUCTURAL_FEATURES,
  fixFeatureRows,
  siteGraph,
  type NodeFacts,
} from "./features.js";
import {
  SCORER_PROTOCOL,
  base64,
  checkResponse,
  float32Base64,
  graphsagePayload,
  graphsageRequest,
  learnedPayload,
  rankerRequest,
  seenSite,
  type GraphSageResponse,
  type RankerResponse,
  type ScoringModelInfo,
} from "./scorers.js";
import type { FixRecord } from "./scoring.js";

const facts = (over: Partial<NodeFacts> = {}): NodeFacts => ({
  pagerank: 0.1,
  depth: 1,
  inNeighbours: 2,
  outNeighbours: 3,
  inLargestScc: true,
  type: "article",
  importance: 0.5,
  ...over,
});

const fix = (donor: string, target: string, over: Partial<FixRecord> = {}): FixRecord =>
  ({
    id: `add-link:${donor}->${target}`,
    donor,
    target,
    type: "add-link",
    deltaPr: 0.002,
    depthBefore: 3,
    depthAfter: 2,
    ref: 0.4,
    cosine: 0.8,
    prominence: { omega: null, weightBefore: 0, weightAfter: 1 },
    kappa: 2,
    templateReach: 5,
    rank: 1,
    ...over,
  }) as FixRecord;

const model = (over: Partial<ScoringModelInfo> = {}): ScoringModelInfo => ({
  kind: "ranker",
  sha256: "abc",
  files: [],
  trainedOn: ["a", "b"],
  trainedOnHosts: ["a.example", "b.example"],
  labels: "e6",
  dataset: "d",
  createdAt: "2026-01-01T00:00:00Z",
  features: [...FEATURES],
  params: { num_leaves: 15 },
  ...over,
});

describe("fixFeatureRows", () => {
  const site = {
    facts: (n: string) =>
      n === "https://s/blog/a"
        ? facts()
        : n === "https://s/blog/b"
          ? facts({ type: "hub", depth: null })
          : undefined,
    donorTerms: new Map([["https://s/blog/a", new Set(["x", "y"])]]),
    targetTerms: new Map([["https://s/blog/b", new Set(["y", "z"])]]),
  };
  const config = { epsilon: 0.1, sigmaBlendLambda: 0.5 };

  it("builds one row per fix, in ranking order, with every feature and S", () => {
    const rows = fixFeatureRows([fix("https://s/blog/a", "https://s/blog/b")], site, config);
    expect(rows).toHaveLength(1);
    const r = rows[0] as (typeof rows)[number];
    for (const f of FEATURES) expect(r).toHaveProperty(f);
    expect(r).toMatchObject({
      fix_id: "add-link:https://s/blog/a->https://s/blog/b",
      rank_s: 1,
      jaccard: 1 / 3,
      depth_gain: 1,
      newly_reachable: 0,
      omega_existing: 0,
      same_section: 1,
      target_type: "hub",
      target_depth: null,
    });
    // S with σ = cosine gated by REF > ε.
    expect(r.s_score).toBeCloseTo((0.002 * 0.8) / 2, 15);
  });

  it("refuses a fix whose end is not a node", () => {
    expect(() => fixFeatureRows([fix("https://s/blog/a", "https://s/gone")], site, config)).toThrow(
      /not a node/,
    );
  });
});

describe("scorer requests", () => {
  it("encodes base64 like RFC 4648, padding included", () => {
    const enc = (s: string) => base64(new TextEncoder().encode(s));
    expect(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map(enc)).toEqual([
      "",
      "Zg==",
      "Zm8=",
      "Zm9v",
      "Zm9vYg==",
      "Zm9vYmE=",
      "Zm9vYmFy",
    ]);
  });

  it("sends node features as little-endian float32", () => {
    const x = Float32Array.from([1, -2.5, 0.1]);
    const bytes = Uint8Array.from(atobBytes(float32Base64(x)));
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2].map((i) => view.getFloat32(i * 4, true))).toEqual([...x]);
  });

  it("builds the ranker and GraphSAGE requests", () => {
    expect(rankerRequest([], FEATURES, 3)).toEqual({
      protocol: SCORER_PROTOCOL,
      kind: "ranker",
      features: FEATURES,
      shapTop: 3,
      rows: [],
    });
    const g = siteGraph(
      ["b", "a"],
      [{ source: "a", target: "b", domRegion: "main" }],
      () => facts(),
      () => Float32Array.from([1, 0]),
      2,
    );
    const r = graphsageRequest(g, STRUCTURAL_FEATURES, [{ id: "f", donor: "b", target: "a" }]);
    expect(r).toMatchObject({
      kind: "graphsage",
      nodes: ["a", "b"],
      embeddingDim: 2,
      src: [0],
      dst: [1],
    });
    expect(atobBytes(r.x).length).toBe(2 * (2 + STRUCTURAL_FEATURES.length) * 4);
  });
});

describe("scorer responses", () => {
  const ranker: RankerResponse = {
    protocol: SCORER_PROTOCOL,
    kind: "ranker",
    model: model(),
    fixes: {
      f: { priority: 0.5, raw: 1, shap: [{ feature: "ref", value: 0.4, contribution: 0.2 }] },
    },
  };

  it("refuses another protocol or kind, and a model without a hash", () => {
    expect(checkResponse(ranker, "ranker")).toBe(ranker);
    expect(() => checkResponse({ ...ranker, protocol: "x" }, "ranker")).toThrow(/linklens-scorer/);
    expect(() => checkResponse(ranker, "graphsage")).toThrow();
    expect(() => checkResponse({ ...ranker, model: {} }, "ranker")).toThrow(/hash/);
    expect(() => checkResponse(null, "ranker")).toThrow();
  });

  it("tells whether the audited site was a training site (host, www. ignored)", () => {
    expect(seenSite(model(), "https://www.a.example/start")).toBe(true);
    expect(seenSite(model(), "https://c.example/")).toBe(false);
    expect(seenSite(model(), "not a url")).toBe(false);
  });

  it("stores the learned payload with the model's hash and source", () => {
    const p = learnedPayload(7, "P3@1.0.0", "https://a.example/", ranker);
    expect(p).toMatchObject({
      version: "learned@1.1.0",
      runId: 7,
      policyVersion: "P3@1.0.0",
      model: {
        site: "https://a.example/",
        trainedOn: ["a", "b"],
        source: "pipeline",
        sha256: "abc",
        seenSite: true,
      },
      fixes: ranker.fixes,
    });
  });

  it("stores pipeline GraphSAGE scores without E6 repeats", () => {
    const r: GraphSageResponse = {
      protocol: SCORER_PROTOCOL,
      kind: "graphsage",
      model: model({ kind: "graphsage" }),
      scores: { f: 1.5 },
    };
    const p = graphsagePayload(7, "P3@1.0.0", "https://c.example/", r, { score: 12 });
    expect(p).toMatchObject({
      version: "graphsage@1.1.0",
      nodes: [],
      repeats: [],
      fixes: { f: 1.5 },
      model: { source: "pipeline", sha256: "abc", seenSite: false, runtimeMs: { score: 12 } },
    });
  });
});

/** base64 → bytes (test helper; the inverse of `base64`). */
function atobBytes(b64: string): number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => b64[i + k] as string);
    const n = c.reduce((acc, ch) => (acc << 6) | (ch === "=" ? 0 : alphabet.indexOf(ch)), 0);
    out.push((n >> 16) & 255);
    if (c[2] !== "=") out.push((n >> 8) & 255);
    if (c[3] !== "=") out.push(n & 255);
  }
  return out;
}
