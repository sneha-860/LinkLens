import {
  canonicalise,
  db as q,
  fixes,
  graph,
  prominence,
  semantic,
  text,
  type LinkLensConfig,
} from "@linklens/core";
import type { Embedder } from "@linklens/embeddings";
import type { RunInputs } from "./in-memory.js";

type PolicyId = canonicalise.PolicyId;

/**
 * E6 (link-masking recovery). Per repeat, a seeded share (e6MaskShareMin–Max) of the site's
 * editorial body links is masked: every observation of each masked pair u→v is removed from the
 * graph, its anchor text leaves u's Links field and (e6StripAnchorsFromBody) u's body text, and
 * the text model, REF and embeddings are rebuilt from the masked site. Each masked edge is then a
 * query: rank the candidate donors of v, and see where u comes.
 *
 * Candidates for (u*, v): every page with text except v, pages that still link to v, and v's
 * other masked donors (so one query has exactly one relevant donor). Ties are broken at random
 * in expectation, so a method that ties many candidates (random, the REF gate) is scored fairly.
 */
export const E6_METHODS = [
  "ref",
  "cosine",
  "jaccard",
  "refGateCosine",
  "blended",
  "random",
  "commonNeighbours",
  "adamicAdar",
  "graphsage",
] as const;
export type E6Method = (typeof E6_METHODS)[number];
export const GRAPH_METHODS: readonly E6Method[] = ["commonNeighbours", "adamicAdar"];
/**
 * Methods scored from outside, only when their scores are supplied: "graphsage" comes from a
 * `graphsage-scores` artefact (config.graphsageEnabled; trained offline in analysis/ml).
 */
export const EXTERNAL_METHODS: readonly E6Method[] = ["graphsage"];

/** Outside scores for one repeat: undefined when a pair was not scored (ranks last). */
export interface ExternalScores {
  readonly graphsage?: (target: string, donor: string) => number | undefined;
}

export interface Ranking {
  /** Candidates scored strictly higher than the relevant donor. */
  readonly above: number;
  /** Candidates with the relevant donor's score, the donor included. */
  readonly tied: number;
  readonly candidates: number;
}

/** Pure: where the relevant candidate (index `relevant`) ranks among `scores`. */
export function rankOf(scores: ArrayLike<number>, relevant: number): Ranking {
  const s = scores[relevant] as number;
  let above = 0;
  let tied = 0;
  for (let i = 0; i < scores.length; i++) {
    const x = scores[i] as number;
    if (x > s) above += 1;
    else if (x === s) tied += 1;
  }
  return { above, tied, candidates: scores.length };
}

/** Recall@k in expectation over random tie-breaking: P(rank ≤ k). */
export const recallAt = (r: Ranking, k: number) => Math.min(1, Math.max(0, (k - r.above) / r.tied));

/** Reciprocal rank in expectation over random tie-breaking. */
export function reciprocalRank(r: Ranking): number {
  let sum = 0;
  for (let rank = r.above + 1; rank <= r.above + r.tied; rank++) sum += 1 / rank;
  return sum / r.tied;
}

/** AUC: P(relevant scores above a random other candidate), ties counting one half. */
export function auc(r: Ranking): number | null {
  const others = r.candidates - 1;
  if (others <= 0) return null;
  const below = r.candidates - r.above - r.tied;
  return (below + 0.5 * (r.tied - 1)) / others;
}

export interface MethodMetrics {
  readonly queries: number;
  readonly recall: Record<number, number>;
  readonly mrr: number;
  readonly auc: number | null;
}

export interface RepeatResult {
  readonly repeat: number;
  readonly seed: number;
  /** The share of editorial pairs drawn for this repeat, and how many that masked. */
  readonly share: number;
  readonly eligiblePairs: number;
  readonly masked: number;
  readonly targets: number;
  /** Masked edges that became queries (both ends have text after masking). */
  readonly queries: number;
  readonly methods: Partial<Record<E6Method, MethodMetrics>>;
  /** The hybrid gated at other ε (E7's sweep), keyed by ε; absent unless asked for. */
  readonly gated?: Record<string, MethodMetrics>;
}

export interface E6Result {
  readonly runId: number;
  readonly policyVersion: string;
  readonly options: {
    readonly shareMin: number;
    readonly shareMax: number;
    readonly repeats: number;
    readonly ks: number[];
    readonly stripAnchorsFromBody: boolean;
    readonly graphBaselines: boolean;
    readonly seed: number;
    readonly epsilon: number;
    readonly lambda: number;
  };
  readonly repeats: RepeatResult[];
  /** Each method's metrics averaged over the repeats. */
  readonly summary: Partial<Record<E6Method, MethodMetrics>>;
  /** The gated hybrid per ε, averaged over the repeats (with `gateEpsilons`). */
  readonly gatedSummary?: Record<string, MethodMetrics>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (u: string, v: string) => JSON.stringify([u, v]);

/** The site as E6 sees it under a policy: pages, links and the editorial pairs. */
export interface EditorialSite {
  readonly build: (links: readonly graph.LinkInput[]) => graph.LinkGraph;
  readonly full: graph.LinkGraph;
  /** Editorial body pairs between two pages with text, sorted. */
  readonly eligible: { readonly donor: string; readonly target: string }[];
  /** Every observation id of each eligible pair. */
  readonly observations: Map<string, number[]>;
}

/** The site's link graph under the policy and its editorial body pairs (maskable). */
export function editorialSite(inputs: RunInputs, policyId: PolicyId): EditorialSite {
  const { config, context, observations } = inputs;
  const policy = canonicalise.POLICIES[policyId];
  const canon = (url: string) => policy.canonicalise(url, context);
  const isInternal = graph.makeInternalTest(observations.seedUrl, config.includeSubdomains);
  const build = (links: readonly graph.LinkInput[]) =>
    graph.buildLinkGraph({
      seedUrl: observations.seedUrl,
      pages: observations.pages,
      links,
      isInternal,
      canonicalise: canon,
    }).graph;
  const full = build(observations.links);
  const pageByFetch = new Map(inputs.pages.map((p) => [p.fetchId, p]));
  const rowsByFetch = new Map<number, q.LinkObservationRow[]>();
  for (const r of inputs.linkRows)
    rowsByFetch.set(r.sourceFetchId, [...(rowsByFetch.get(r.sourceFetchId) ?? []), r]);
  // Region and site-wide template of every observation, on the representative pages.
  const pageLinks: prominence.PageLinks[] = [];
  full.forEachNode((node, a) => {
    const page =
      a.representativeFetchId === null ? undefined : pageByFetch.get(a.representativeFetchId);
    if (page === undefined) return;
    pageLinks.push({
      node,
      links: (rowsByFetch.get(page.fetchId) ?? []).map((r) => ({
        observationId: r.id,
        domRegion: r.domRegion,
        templateSignature: r.templateSignature,
        positionIndex: r.positionIndex,
        target: full.hasEdge(`obs:${r.id}`) ? full.target(`obs:${r.id}`) : null,
      })),
    });
  });
  const { factors } = prominence.observationFactors(pageLinks, config);
  const hasText = (n: string) => {
    const id = full.getNodeAttribute(n, "representativeFetchId");
    const page = id === null ? undefined : pageByFetch.get(id);
    return page !== undefined && ((page.bodyText ?? "") !== "" || (page.title ?? "") !== "");
  };
  const observationsOf = new Map<string, number[]>();
  const editorial = new Set<string>();
  full.forEachEdge((_e, a, s, t) => {
    if (s === t) return;
    const key = pairKey(s, t);
    observationsOf.set(key, [...(observationsOf.get(key) ?? []), a.observationId]);
    const f = factors.get(a.observationId);
    if (f !== undefined && f.region === "body" && !f.sitewide && hasText(s) && hasText(t)) {
      editorial.add(key);
    }
  });
  const eligible = [...editorial]
    .sort()
    .map((k) => JSON.parse(k) as [string, string])
    .map(([donor, target]) => ({ donor, target }));
  return { build, full, eligible, observations: observationsOf };
}

/**
 * Remove the first occurrence of each anchor text from a body text (as written; else ignoring
 * case, as at the start of a sentence).
 */
export function stripAnchors(body: string, anchors: readonly string[]): string {
  let out = body;
  for (const a of anchors) {
    const t = a.trim();
    if (t === "") continue;
    let at = out.indexOf(t);
    if (at < 0) at = out.toLowerCase().indexOf(t.toLowerCase());
    if (at >= 0) out = out.slice(0, at) + out.slice(at + t.length);
  }
  return out;
}

/** The documents and graph of one masked repeat. */
export interface MaskedSite {
  readonly masked: { readonly donor: string; readonly target: string }[];
  readonly share: number;
  readonly documents: text.RawDocument[];
  readonly graph: graph.LinkGraph;
  /** The hidden link observations, and each source page's body with their anchors stripped. */
  readonly hidden: ReadonlySet<number>;
  readonly bodies: ReadonlyMap<number, string | null>;
}

/** Pure: draw a repeat's masked pairs and rebuild the site without them. */
export function maskSite(
  inputs: RunInputs,
  s: EditorialSite,
  seed: number,
  config: Pick<LinkLensConfig, "e6MaskShareMin" | "e6MaskShareMax" | "e6StripAnchorsFromBody">,
): MaskedSite {
  const random = graph.mulberry32(seed);
  const share = config.e6MaskShareMin + (config.e6MaskShareMax - config.e6MaskShareMin) * random();
  const n = s.eligible.length === 0 ? 0 : Math.max(1, Math.round(share * s.eligible.length));
  const masked = graph
    .sampleWithoutReplacement(s.eligible, n, random)
    .sort((a, b) => cmp(a.donor, b.donor) || cmp(a.target, b.target));
  const hidden = new Set(
    masked.flatMap((m) => s.observations.get(pairKey(m.donor, m.target)) ?? []),
  );
  const links = inputs.observations.links.filter((l) => !hidden.has(l.id));
  const rows = inputs.linkRows.filter((l) => !hidden.has(l.id));
  const g = s.build(links);

  // Anchors of the masked observations, per source page (to strip from its body).
  const anchors = new Map<number, string[]>();
  for (const r of inputs.linkRows) {
    if (!hidden.has(r.id) || r.anchorText === null) continue;
    anchors.set(r.sourceFetchId, [...(anchors.get(r.sourceFetchId) ?? []), r.anchorText]);
  }
  const pageByFetch = new Map(inputs.pages.map((p) => [p.fetchId, p]));
  const rowsByFetch = new Map<number, q.LinkObservationRow[]>();
  for (const r of rows)
    rowsByFetch.set(r.sourceFetchId, [...(rowsByFetch.get(r.sourceFetchId) ?? []), r]);
  const documents: text.RawDocument[] = [];
  const bodies = new Map<number, string | null>();
  g.forEachNode((node, a) => {
    const page =
      a.representativeFetchId === null ? undefined : pageByFetch.get(a.representativeFetchId);
    if (page === undefined) return;
    const body =
      config.e6StripAnchorsFromBody && page.bodyText !== null
        ? stripAnchors(page.bodyText, anchors.get(page.fetchId) ?? [])
        : page.bodyText;
    if (body !== page.bodyText) bodies.set(page.fetchId, body);
    documents.push(
      text.rawDocument(node, { ...page, bodyText: body }, rowsByFetch.get(page.fetchId) ?? []),
    );
  });
  return { masked, share, documents, graph: g, hidden, bodies };
}

/**
 * The run's inputs as the masked site: its hidden observations removed and its stripped bodies,
 * so the whole in-memory pipeline (prepareRun) sees the site without the masked links (L13).
 */
export function maskedInputs(
  inputs: RunInputs,
  m: Pick<MaskedSite, "hidden" | "bodies">,
): RunInputs {
  return {
    ...inputs,
    observations: {
      ...inputs.observations,
      links: inputs.observations.links.filter((l) => !m.hidden.has(l.id)),
    },
    linkRows: inputs.linkRows.filter((l) => !m.hidden.has(l.id)),
    pages: inputs.pages.map((p) =>
      m.bodies.has(p.fetchId) ? { ...p, bodyText: m.bodies.get(p.fetchId) ?? null } : p,
    ),
  };
}

/**
 * Pure: score every candidate donor of every masked target with every method and measure where
 * the masked donor lands. `vector(node)` is the node's embedding (L2-normalised) in the masked
 * site; `config` gives ε, λ, the tokeniser and the ks.
 */
export function rankMasked(
  m: MaskedSite,
  vector: (node: string) => Float32Array | undefined,
  runId: number,
  policyVersion: string,
  config: Readonly<LinkLensConfig>,
  gateEpsilons: readonly number[] = [],
  external: ExternalScores = {},
): Pick<RepeatResult, "targets" | "queries" | "methods" | "gated"> {
  const model = text.buildTextModel({ runId, policyVersion, documents: m.documents }, config);
  const docs = [...model.documents].sort((a, b) => cmp(a.node, b.node));
  const index = new Map(docs.map((d, i) => [d.node, i]));
  const donorSets = docs.map((d) => new Set(d.donor));
  const methods = E6_METHODS.filter(
    (x) =>
      (config.e6GraphBaselines || !GRAPH_METHODS.includes(x)) &&
      (!EXTERNAL_METHODS.includes(x) || external[x as keyof ExternalScores] !== undefined),
  );
  const neighbours = new Map<string, Set<string>>();
  const around = (n: string) => {
    let set = neighbours.get(n);
    if (set === undefined) {
      set = new Set(m.graph.hasNode(n) ? m.graph.neighbors(n).filter((x) => x !== n) : []);
      neighbours.set(n, set);
    }
    return set;
  };

  const byTarget = new Map<string, string[]>();
  for (const x of m.masked) {
    if (!index.has(x.donor) || !index.has(x.target)) continue;
    byTarget.set(x.target, [...(byTarget.get(x.target) ?? []), x.donor]);
  }
  const perQuery: Record<
    string,
    { recall: Record<number, number>; rr: number; auc: number | null }[]
  > = {};
  const keys = [...methods, ...gateEpsilons.map((e) => `gate:${e}`)];
  for (const key of keys) perQuery[key] = [];

  for (const [target, maskedDonors] of [...byTarget].sort((a, b) => cmp(a[0], b[0]))) {
    const v = index.get(target) as number;
    const tw = semantic.targetWeights(docs[v] as text.TextDocument);
    const targetTerms = new Set(tw.keys());
    const tv = vector(target);
    const nv = around(target);
    // Every page with text but the target and pages that still link to it.
    const pool = docs
      .map((d) => d.node)
      .filter((u) => u !== target && !m.graph.hasDirectedEdge(u, target));
    const scores = new Map<string, Map<string, number>>();
    for (const key of keys) scores.set(key, new Map());
    for (const u of pool) {
      const i = index.get(u) as number;
      const r = semantic.ref(donorSets[i] as Set<string>, tw, "weighted");
      const uv = vector(u);
      let cos = 0;
      if (uv !== undefined && tv !== undefined)
        for (let k = 0; k < uv.length; k++) cos += (uv[k] as number) * (tv[k] as number);
      const hasCos = uv !== undefined && tv !== undefined;
      const sigmas = fixes.sigmaValues(r, hasCos ? cos : null, config);
      let inter = 0;
      for (const t of donorSets[i] as Set<string>) if (targetTerms.has(t)) inter += 1;
      const union = (donorSets[i] as Set<string>).size + targetTerms.size - inter;
      const set = (method: E6Method, value: number) => scores.get(method)?.set(u, value);
      set("ref", r);
      set("cosine", hasCos ? cos : -Infinity);
      set("jaccard", union === 0 ? 0 : inter / union);
      set("refGateCosine", sigmas.refGateCosine);
      set("blended", sigmas.blended);
      set("random", 0);
      if (external.graphsage !== undefined)
        set("graphsage", external.graphsage(target, u) ?? -Infinity);
      for (const e of gateEpsilons) scores.get(`gate:${e}`)?.set(u, r > e && hasCos ? cos : 0);
      if (config.e6GraphBaselines) {
        const nu = around(u);
        let cn = 0;
        let aa = 0;
        for (const w of nu) {
          if (!nv.has(w)) continue;
          cn += 1;
          const d = around(w).size;
          if (d > 1) aa += 1 / Math.log(d);
        }
        set("commonNeighbours", cn);
        set("adamicAdar", aa);
      }
    }
    for (const donor of maskedDonors) {
      const others = new Set(maskedDonors.filter((x) => x !== donor));
      const candidates = pool.filter((u) => !others.has(u));
      const relevant = candidates.indexOf(donor);
      if (relevant < 0) continue; // the donor still links to v through an unmasked observation
      for (const method of keys) {
        const s = scores.get(method) as Map<string, number>;
        const r = rankOf(
          candidates.map((u) => s.get(u) as number),
          relevant,
        );
        perQuery[method]?.push({
          recall: Object.fromEntries(config.e6Ks.map((k) => [k, recallAt(r, k)])),
          rr: reciprocalRank(r),
          auc: auc(r),
        });
      }
    }
  }

  const mean = (xs: readonly number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const metricsOf = (key: string): MethodMetrics => {
    const qs = perQuery[key] ?? [];
    const aucs = qs.flatMap((x) => (x.auc === null ? [] : [x.auc]));
    return {
      queries: qs.length,
      recall: Object.fromEntries(
        config.e6Ks.map((k) => [k, mean(qs.map((x) => x.recall[k] as number))]),
      ),
      mrr: mean(qs.map((x) => x.rr)),
      auc: aucs.length === 0 ? null : mean(aucs),
    };
  };
  const out: Partial<Record<E6Method, MethodMetrics>> = {};
  for (const method of methods) out[method] = metricsOf(method);
  return {
    targets: byTarget.size,
    queries: perQuery[methods[0] as string]?.length ?? 0,
    methods: out,
    ...(gateEpsilons.length === 0
      ? {}
      : {
          gated: Object.fromEntries(gateEpsilons.map((e) => [String(e), metricsOf(`gate:${e}`)])),
        }),
  };
}

/** Metrics averaged over repeats (those without queries are skipped); null when none has any. */
export function averageMetrics(
  ms: readonly (MethodMetrics | undefined)[],
  ks: readonly number[],
): MethodMetrics | null {
  const used = ms.filter((x): x is MethodMetrics => x !== undefined && x.queries > 0);
  if (used.length === 0) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const aucs = used.flatMap((x) => (x.auc === null ? [] : [x.auc]));
  return {
    queries: used.reduce((s, x) => s + x.queries, 0),
    recall: Object.fromEntries(ks.map((k) => [k, mean(used.map((x) => x.recall[k] as number))])),
    mrr: mean(used.map((x) => x.mrr)),
    auc: aucs.length === 0 ? null : mean(aucs),
  };
}

/** Each method's metrics averaged over the repeats (repeats without queries are skipped). */
export function summariseRepeats(
  repeats: readonly RepeatResult[],
  ks: readonly number[],
): Partial<Record<E6Method, MethodMetrics>> {
  const out: Partial<Record<E6Method, MethodMetrics>> = {};
  for (const method of E6_METHODS) {
    const m = averageMetrics(
      repeats.map((r) => r.methods[method]),
      ks,
    );
    if (m !== null) out[method] = m;
  }
  return out;
}

/**
 * E6 on a stored run: e6Repeats masked repeats (seeds seed, seed + 1, …), each embedded with
 * `embedder` (the run's model; unchanged pages come from its cache).
 */
export async function maskingRecovery(
  inputs: RunInputs,
  policyId: PolicyId,
  embedder: Embedder,
  seed: number = inputs.config.randomSeed,
  options: {
    readonly gateEpsilons?: readonly number[];
    /** GraphSAGE scores for the masked repeats (adds the "graphsage" method). */
    readonly graphsage?: fixes.GraphSageScores;
  } = {},
): Promise<E6Result> {
  const gateEpsilons = options.gateEpsilons ?? [];
  const gs = options.graphsage;
  const gsLookup = gs === undefined ? undefined : fixes.graphsageLookup(gs);
  const { config } = inputs;
  const o = embedder.options;
  if (
    o.model !== config.embeddingModel ||
    o.dtype !== config.embeddingDtype ||
    o.bodyTokens !== config.embeddingBodyTokens
  ) {
    throw new Error(
      `embedder (${o.model}, ${o.dtype}) does not match run ${inputs.runId}'s config`,
    );
  }
  const policyVersion = canonicalise.POLICIES[policyId].version;
  const s = editorialSite(inputs, policyId);
  const repeats: RepeatResult[] = [];
  for (let r = 0; r < config.e6Repeats; r++) {
    const m = maskSite(inputs, s, seed + r, config);
    if (gs !== undefined && !gs.repeats.some((x) => x.repeat === r && x.seed === seed + r)) {
      throw new Error(
        `graphsage-scores for run ${inputs.runId} has no repeat ${r} with seed ${seed + r}: export and score the graphs with the same seed and e6Repeats`,
      );
    }
    const inputsToEmbed = m.documents
      .map(semantic.embeddingInput)
      .sort((a, b) => cmp(a.node, b.node));
    const { vectors } = await embedder.embed(
      inputsToEmbed.map(({ title, body }) => ({ title, body })),
    );
    const vector = new Map(inputsToEmbed.map((d, i) => [d.node, vectors[i] as Float32Array]));
    repeats.push({
      repeat: r,
      seed: seed + r,
      share: m.share,
      eligiblePairs: s.eligible.length,
      masked: m.masked.length,
      ...rankMasked(
        m,
        (n) => vector.get(n),
        inputs.runId,
        policyVersion,
        config,
        gateEpsilons,
        gsLookup === undefined ? {} : { graphsage: (t, d) => gsLookup(r, t, d) },
      ),
    });
  }
  return {
    runId: inputs.runId,
    policyVersion,
    options: {
      shareMin: config.e6MaskShareMin,
      shareMax: config.e6MaskShareMax,
      repeats: config.e6Repeats,
      ks: [...config.e6Ks],
      stripAnchorsFromBody: config.e6StripAnchorsFromBody,
      graphBaselines: config.e6GraphBaselines,
      seed,
      epsilon: config.epsilon,
      lambda: config.sigmaBlendLambda,
    },
    repeats,
    summary: summariseRepeats(repeats, config.e6Ks),
    ...(gateEpsilons.length === 0
      ? {}
      : {
          gatedSummary: Object.fromEntries(
            gateEpsilons.flatMap((e) => {
              const m = averageMetrics(
                repeats.map((r) => r.gated?.[String(e)]),
                config.e6Ks,
              );
              return m === null ? [] : [[String(e), m]];
            }),
          ),
        }),
  };
}
