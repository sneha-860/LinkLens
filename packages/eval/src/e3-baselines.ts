import {
  audit as auditCore,
  canonicalise,
  db as q,
  fixes,
  graph,
  semantic,
  text,
  type LinkLensConfig,
  type SigmaVariant,
} from "@linklens/core";
import type { Embedder } from "@linklens/embeddings";

type PolicyId = canonicalise.PolicyId;

/**
 * E3 compares four ways of choosing k fixes for a site's weak-authority and orphan pages, all
 * from the same admissible pool:
 * - linklens: LinkLens's score S(u→v) = ΔPR_v × σ(u,v) / κ(u);
 * - random: admissible pairs drawn at random (the mean of e3RandomDraws seeded draws);
 * - highestCosine: the most similar donor–target pairs, ignoring the graph gain;
 * - highestPagerank: the pairs whose donor has the highest PageRank, ignoring semantics.
 * The measure is the joint one: the k links are applied together, PageRank is recomputed, and
 * the ΔPR of every weak or orphan page is summed.
 */
export const E3_METHODS = ["linklens", "random", "highestCosine", "highestPagerank"] as const;
export type E3Method = (typeof E3_METHODS)[number];
export const E3_BASELINES: readonly E3Method[] = ["random", "highestCosine", "highestPagerank"];

export type TargetKind = "weak" | "orphan";

/** One admissible fix: a donor → target link, with what each method ranks it by. */
export interface PoolEntry {
  readonly id: string;
  readonly donor: string;
  readonly target: string;
  readonly kind: TargetKind;
  readonly action: fixes.CandidateAction;
  readonly ref: number;
  /** cos(u, v) of the page embeddings (null: no embedding for one of them). */
  readonly cosine: number | null;
  /** The donor's PageRank in the weighted graph (before any fix). */
  readonly donorPagerank: number;
  /** ΔPR of the target when this link alone is added (the counterfactual engine). */
  readonly deltaPr: number;
  readonly kappa: number;
  /** S(u→v) = ΔPR × σ / κ with the run's σ variant. */
  readonly score: number;
}

export interface E3Inputs {
  /** The structural-prominence graph plus the orphan nodes (as orphan rescue uses). */
  readonly graph: fixes.WeightedGraph;
  readonly base: fixes.Baseline;
  readonly bodyWeight: number;
  readonly params: fixes.PageRankParams;
  /** The weak-authority pages and the orphans: whose ΔPR is summed. */
  readonly targets: readonly { readonly node: string; readonly kind: TargetKind }[];
  readonly pool: readonly PoolEntry[];
  readonly sigma: SigmaVariant;
}

export interface MethodOutcome {
  readonly method: E3Method;
  /** Fixes applied (fewer than k when the pool is smaller). */
  readonly selected: number;
  /** Distinct targets among them. */
  readonly targetsCovered: number;
  /** Σ over the weak and orphan pages of PR after all the fixes − PR before. */
  readonly totalDeltaPr: number;
  /** Random only: the standard deviation of totalDeltaPr over the draws. */
  readonly totalDeltaPrSd: number | null;
  /** Σ of the fixes' single-link ΔPR (what adding them up would suggest). */
  readonly sumSingleDeltaPr: number;
  /** Σ_i |PR'(i) − PR(i)| over the whole site. */
  readonly deltaPrL1: number;
  /** Weak or orphan pages unreachable before and reachable after. */
  readonly newlyReachable: number;
  readonly meanRef: number | null;
  readonly meanCosine: number | null;
  /** The fixes applied, in rank order (null for random: see the draws). */
  readonly fixes: string[] | null;
}

export interface E3Result {
  readonly sigma: SigmaVariant;
  readonly seed: number;
  readonly randomDraws: number;
  readonly ks: number[];
  readonly targets: { readonly weak: number; readonly orphan: number; readonly total: number };
  readonly pool: {
    readonly pairs: number;
    readonly weakPairs: number;
    readonly orphanPairs: number;
    readonly weakTargetsWithDonors: number;
    readonly orphanTargetsWithDonors: number;
  };
  /** Σ PR of the weak and orphan pages before any fix. */
  readonly targetPagerankBefore: number;
  readonly byK: { readonly k: number; readonly methods: MethodOutcome[] }[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const mean = (xs: readonly number[]) =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

/** Pure: the pool in a deterministic method's order (random has no order: see compareE3). */
export function rankPool(
  pool: readonly PoolEntry[],
  method: Exclude<E3Method, "random">,
): PoolEntry[] {
  const tie = (a: PoolEntry, b: PoolEntry) => cmp(a.donor, b.donor) || cmp(a.target, b.target);
  const by: Record<typeof method, (a: PoolEntry, b: PoolEntry) => number> = {
    linklens: (a, b) => b.score - a.score || b.deltaPr - a.deltaPr || tie(a, b),
    // A missing cosine ranks last.
    highestCosine: (a, b) =>
      (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity) ||
      (a.cosine === null ? 1 : 0) - (b.cosine === null ? 1 : 0) ||
      tie(a, b),
    highestPagerank: (a, b) => b.donorPagerank - a.donorPagerank || tie(a, b),
  };
  return [...pool].sort(by[method]);
}

/** Pure: apply a set of fixes together and measure it on the weak and orphan pages. */
export function evaluateSelection(
  inputs: E3Inputs,
  selection: readonly PoolEntry[],
): Omit<MethodOutcome, "method" | "totalDeltaPrSd" | "fixes"> {
  const index = new Map(inputs.graph.nodes.map((n, i) => [n, i]));
  const at = (n: string) => {
    const i = index.get(n);
    if (i === undefined) throw new Error(`${n} is not in the graph`);
    return i;
  };
  const joint = fixes.applyLinks(
    inputs.graph,
    inputs.base,
    selection.map((e) => ({ donor: at(e.donor), target: at(e.target) })),
    inputs.bodyWeight,
    inputs.params,
  );
  let total = 0;
  let newlyReachable = 0;
  for (const t of inputs.targets) {
    const i = at(t.node);
    total += (joint.rank[i] as number) - (inputs.base.rank[i] as number);
    if ((inputs.base.depth[i] as number) < 0 && (joint.depth[i] as number) >= 0)
      newlyReachable += 1;
  }
  return {
    selected: selection.length,
    targetsCovered: new Set(selection.map((e) => e.target)).size,
    totalDeltaPr: total,
    sumSingleDeltaPr: selection.reduce((s, e) => s + e.deltaPr, 0),
    deltaPrL1: joint.deltaPrL1,
    newlyReachable,
    meanRef: mean(selection.map((e) => e.ref)),
    meanCosine: mean(selection.flatMap((e) => (e.cosine === null ? [] : [e.cosine]))),
  };
}

/**
 * Pure (E3): every method's top-k for each k, applied together and measured. The random
 * baseline is `draws` seeded samples of k distinct pool entries, averaged (each k has its own
 * stream, seeded by seed + k, so a result does not depend on which other ks are run).
 */
export function compareE3(
  inputs: E3Inputs,
  ks: readonly number[],
  draws: number,
  seed: number,
): E3Result {
  const ranked = {
    linklens: rankPool(inputs.pool, "linklens"),
    highestCosine: rankPool(inputs.pool, "highestCosine"),
    highestPagerank: rankPool(inputs.pool, "highestPagerank"),
  };
  // A stable base order for sampling, independent of how the pool was built.
  const byId = [...inputs.pool].sort((a, b) => cmp(a.id, b.id));
  const targetIndex = new Map(inputs.graph.nodes.map((n, i) => [n, i]));
  const before = inputs.targets.reduce(
    (s, t) => s + (inputs.base.rank[targetIndex.get(t.node) as number] as number),
    0,
  );
  const kinds = (kind: TargetKind) => inputs.targets.filter((t) => t.kind === kind).length;
  const withDonors = (kind: TargetKind) =>
    new Set(inputs.pool.filter((e) => e.kind === kind).map((e) => e.target)).size;

  const byK = [...ks]
    .sort((a, b) => a - b)
    .map((k) => {
      const methods: MethodOutcome[] = [];
      for (const method of E3_METHODS) {
        if (method === "random") {
          const random = graph.mulberry32(seed + k);
          const outcomes = Array.from({ length: draws }, () =>
            evaluateSelection(
              inputs,
              graph.sampleWithoutReplacement(byId, Math.min(k, byId.length), random),
            ),
          );
          const m = (f: (o: (typeof outcomes)[number]) => number) =>
            mean(outcomes.map(f)) as number;
          const totals = outcomes.map((o) => o.totalDeltaPr);
          const mu = m((o) => o.totalDeltaPr);
          const sd =
            totals.length < 2
              ? 0
              : Math.sqrt(totals.reduce((s, x) => s + (x - mu) ** 2, 0) / (totals.length - 1));
          const meanOf = (f: (o: (typeof outcomes)[number]) => number | null) =>
            mean(outcomes.flatMap((o) => (f(o) === null ? [] : [f(o) as number])));
          methods.push({
            method,
            selected: Math.min(k, byId.length),
            targetsCovered: m((o) => o.targetsCovered),
            totalDeltaPr: mu,
            totalDeltaPrSd: sd,
            sumSingleDeltaPr: m((o) => o.sumSingleDeltaPr),
            deltaPrL1: m((o) => o.deltaPrL1),
            newlyReachable: m((o) => o.newlyReachable),
            meanRef: meanOf((o) => o.meanRef),
            meanCosine: meanOf((o) => o.meanCosine),
            fixes: null,
          });
        } else {
          const top = ranked[method].slice(0, k);
          methods.push({
            method,
            ...evaluateSelection(inputs, top),
            totalDeltaPrSd: null,
            fixes: top.map((e) => e.id),
          });
        }
      }
      return { k, methods };
    });

  return {
    sigma: inputs.sigma,
    seed,
    randomDraws: draws,
    ks: byK.map((b) => b.k),
    targets: { weak: kinds("weak"), orphan: kinds("orphan"), total: inputs.targets.length },
    pool: {
      pairs: inputs.pool.length,
      weakPairs: inputs.pool.filter((e) => e.kind === "weak").length,
      orphanPairs: inputs.pool.filter((e) => e.kind === "orphan").length,
      weakTargetsWithDonors: withDonors("weak"),
      orphanTargetsWithDonors: withDonors("orphan"),
    },
    targetPagerankBefore: before,
    byK,
  };
}

function cosineOfVectors(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot; // the vectors are L2-normalised
}

/**
 * Everything E3 needs for a run under `policyId` (the run's stored config); nothing is written.
 * - Graph: orphan rescue's (structural prominence W, plus the orphan nodes), so fixes for weak
 *   pages and for orphans are measured on one graph.
 * - Targets: the audit's weak-authority pages and the reconciled orphans.
 * - Pool: the fix candidates of weak-authority targets (add-link or make-visible) and each
 *   orphan's rescue shortlist (donor → orphan). Every entry is simulated alone for its ΔPR.
 * - Cosine: from `embedder` (the run's model), for crawled pages and for the fetched orphan
 *   pages alike; orphans are not embedded by the pipeline.
 */
export async function loadE3Inputs(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
  embedder: Embedder,
  options: { readonly sigma?: SigmaVariant; readonly refVariant?: semantic.RefVariant } = {},
): Promise<{ inputs: E3Inputs; config: Readonly<LinkLensConfig> }> {
  const refVariant = options.refVariant ?? "weighted";
  const [rescue, audit, { list }, effort, { documents }] = await Promise.all([
    fixes.loadRescueInputs(db, runId, policyId, refVariant),
    auditCore.loadAudit(db, runId, policyId),
    fixes.loadCandidates(db, runId, policyId, refVariant),
    fixes.loadDonorEffort(db, runId, policyId),
    text.loadRunDocuments(db, runId, policyId),
  ]);
  const { config, graph: g, bodyWeight } = rescue;
  const sigma = options.sigma ?? config.sigmaVariant;
  const o = embedder.options;
  if (
    o.model !== config.embeddingModel ||
    o.dtype !== config.embeddingDtype ||
    o.bodyTokens !== config.embeddingBodyTokens
  ) {
    throw new Error(
      `embedder (${o.model}, ${o.dtype}, ${o.bodyTokens} tokens) does not match run ${runId}'s config`,
    );
  }
  const params: fixes.PageRankParams = {
    pagerankDamping: config.pagerankDamping,
    pagerankTolerance: config.pagerankTolerance,
    pagerankMaxIterations: config.pagerankMaxIterations,
  };
  const base = fixes.baseline(g, params);
  const index = new Map(g.nodes.map((n, i) => [n, i]));

  // Targets.
  const weak = [
    ...new Set(audit.issues.filter((i) => i.type === "weak-authority").map((i) => i.node)),
  ].sort();
  const orphanNodes = rescue.orphans.map((x) => x.node).sort();
  const targets = [
    ...weak.map((node) => ({ node, kind: "weak" as const })),
    ...orphanNodes
      .filter((n) => !weak.includes(n))
      .map((node) => ({ node, kind: "orphan" as const })),
  ];

  // Pool: weak-authority fix candidates, and the orphans' rescue shortlists.
  const raw: Omit<PoolEntry, "cosine" | "donorPagerank" | "deltaPr" | "kappa" | "score">[] = [];
  for (const c of list.candidates) {
    if (!c.targetReasons.includes("weak-authority")) continue;
    raw.push({
      id: c.id,
      donor: c.donor,
      target: c.target,
      kind: "weak",
      action: c.action,
      ref: c.ref,
    });
  }
  const shortlists = fixes.rescueShortlists(
    rescue.orphans,
    rescue.model,
    rescue.depth,
    refVariant,
    config,
  );
  for (const s of shortlists) {
    for (const e of s.shortlist) {
      raw.push({
        id: `add-link:${e.donor}->${s.orphan.node}`,
        donor: e.donor,
        target: s.orphan.node,
        kind: "orphan",
        action: "add-link",
        ref: e.ref,
      });
    }
  }

  // Embeddings of every page a pool entry touches (crawled documents and orphan pages).
  const docs = new Map(documents.map((d) => [d.node, semantic.embeddingInput(d)]));
  for (const x of rescue.orphans) {
    if (x.page === null) continue;
    docs.set(
      x.node,
      semantic.embeddingInput({
        node: x.node,
        fetchId: 0,
        url: x.node,
        title: x.page.title,
        links: [],
        body: x.page.body,
      }),
    );
  }
  const needed = [...new Set(raw.flatMap((e) => [e.donor, e.target]))]
    .filter((n) => docs.has(n))
    .sort();
  const embedded = await embedder.embed(
    needed.map((n) => {
      const d = docs.get(n) as semantic.EmbeddingInput;
      return { title: d.title, body: d.body };
    }),
  );
  const vector = new Map(needed.map((n, i) => [n, embedded.vectors[i] as Float32Array]));

  const ws = fixes.workspace(g);
  const pool: PoolEntry[] = raw.map((e) => {
    const donor = index.get(e.donor);
    const target = index.get(e.target);
    if (donor === undefined || target === undefined)
      throw new Error(`${e.id}: an end is not in the graph`);
    const single = fixes.simulate(
      g,
      base,
      { id: e.id, donor, target, action: e.action },
      bodyWeight,
      params,
      true,
      ws,
    );
    const vu = vector.get(e.donor);
    const vv = vector.get(e.target);
    const cosine = vu === undefined || vv === undefined ? null : cosineOfVectors(vu, vv);
    const kappa = effort.get(e.donor)?.kappa ?? 1;
    const s = fixes.sigmaValues(e.ref, cosine, config)[sigma];
    return {
      ...e,
      cosine,
      donorPagerank: base.rank[donor] as number,
      deltaPr: single.deltaPrTarget,
      kappa,
      score: fixes.fixScore(single.deltaPrTarget, s, kappa),
    };
  });

  return { inputs: { graph: g, base, bodyWeight, params, targets, pool, sigma }, config };
}
