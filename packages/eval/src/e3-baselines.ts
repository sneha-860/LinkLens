import { canonicalise, db as q, fixes, graph, stats, type SigmaVariant } from "@linklens/core";

type PolicyId = canonicalise.PolicyId;

/** One admissible donor for a target, with what its link would do. */
export interface DonorOption {
  readonly donor: string;
  readonly target: string;
  readonly ref: number;
  readonly sameSection: boolean;
  readonly donorPagerank: number;
  readonly deltaPr: number;
  readonly deltaDepth: number | null;
  /** LinkLens's rank of this fix for the target (1 = its pick). */
  readonly targetRank: number;
}

export const METHODS = [
  "linklens",
  "refOnly",
  "highestPagerank",
  "random",
  "sameSectionRandom",
  "homePage",
  "oracle",
] as const;
export type Method = (typeof METHODS)[number];

export interface MethodResult {
  readonly method: Method;
  /** Targets where the method could pick (the home page is not always admissible). */
  readonly targets: number;
  readonly meanDeltaPr: number | null;
  /** Mean share of the best achievable ΔPR for the target (1 = the oracle's pick). */
  readonly meanShareOfBest: number | null;
  /** Mean depth gain (negative = shallower) over picks with a defined Δdepth. */
  readonly meanDeltaDepth: number | null;
  /** Mean REF of the pick: how related the donor is. */
  readonly meanRef: number | null;
  /** Share of targets where LinkLens's pick has a larger ΔPR (ties excluded). */
  readonly linklensWinRate: number | null;
}

export interface BaselineComparison {
  readonly targets: number;
  readonly sigma: SigmaVariant;
  readonly methods: MethodResult[];
  /** Per target, each method's pick and its ΔPR (for paired tests in analysis/). */
  readonly perTarget: {
    readonly target: string;
    readonly picks: Partial<Record<Method, { readonly donor: string; readonly deltaPr: number }>>;
  }[];
}

/** Deterministic pick from a list by a seeded draw. */
const pickOne = <T>(items: readonly T[], random: () => number): T | undefined =>
  items.length === 0 ? undefined : items[Math.floor(random() * items.length)];

/**
 * E3: for every target, each method picks one donor among the same admissible candidates, and
 * the picks are compared by what the simulated link does (ΔPR, share of the best ΔPR, depth
 * gain) and by how related the donor is (REF). "oracle" is the best-ΔPR donor (an upper bound).
 */
export function compareWithBaselines(
  options: readonly DonorOption[],
  seedNode: string,
  sigma: SigmaVariant,
  seed: number,
): BaselineComparison {
  const byTarget = new Map<string, DonorOption[]>();
  for (const o of options) byTarget.set(o.target, [...(byTarget.get(o.target) ?? []), o]);
  const random = graph.mulberry32(seed);
  const sorted = [...byTarget.keys()].sort();
  const picks = new Map<Method, { target: string; pick: DonorOption; best: number }[]>();
  for (const m of METHODS) picks.set(m, []);
  const max = (xs: DonorOption[], f: (o: DonorOption) => number) =>
    xs.reduce((a, b) => (f(b) > f(a) || (f(b) === f(a) && b.donor < a.donor) ? b : a));

  for (const t of sorted) {
    const cands = [...(byTarget.get(t) as DonorOption[])].sort((a, b) =>
      a.donor < b.donor ? -1 : 1,
    );
    const best = Math.max(...cands.map((c) => c.deltaPr));
    const chosen: Record<Method, DonorOption | undefined> = {
      linklens: cands.find((c) => c.targetRank === 1) ?? max(cands, (c) => -c.targetRank),
      refOnly: max(cands, (c) => c.ref),
      highestPagerank: max(cands, (c) => c.donorPagerank),
      random: pickOne(cands, random),
      sameSectionRandom:
        pickOne(
          cands.filter((c) => c.sameSection),
          random,
        ) ?? pickOne(cands, random),
      homePage: cands.find((c) => c.donor === seedNode),
      oracle: max(cands, (c) => c.deltaPr),
    };
    for (const m of METHODS) {
      const p = chosen[m];
      if (p !== undefined) picks.get(m)?.push({ target: t, pick: p, best });
    }
  }
  const ours = new Map((picks.get("linklens") ?? []).map((p) => [p.target, p.pick.deltaPr]));
  const perTarget = sorted.map((target) => ({
    target,
    picks: Object.fromEntries(
      METHODS.flatMap((m) => {
        const p = picks.get(m)?.find((x) => x.target === target);
        return p === undefined ? [] : [[m, { donor: p.pick.donor, deltaPr: p.pick.deltaPr }]];
      }),
    ) as BaselineComparison["perTarget"][number]["picks"],
  }));
  return {
    targets: sorted.length,
    sigma,
    perTarget,
    methods: METHODS.map((method) => {
      const ps = picks.get(method) ?? [];
      const decided = ps.filter((p) => ours.has(p.target) && ours.get(p.target) !== p.pick.deltaPr);
      return {
        method,
        targets: ps.length,
        meanDeltaPr: stats.mean(ps.map((p) => p.pick.deltaPr)),
        meanShareOfBest: stats.mean(ps.map((p) => (p.best > 0 ? p.pick.deltaPr / p.best : 1))),
        meanDeltaDepth: stats.mean(
          ps.flatMap((p) => (p.pick.deltaDepth === null ? [] : [p.pick.deltaDepth])),
        ),
        meanRef: stats.mean(ps.map((p) => p.pick.ref)),
        linklensWinRate:
          method === "linklens" || decided.length === 0
            ? null
            : decided.filter((p) => (ours.get(p.target) as number) > p.pick.deltaPr).length /
              decided.length,
      };
    }),
  };
}

/** The admissible donors of every target from a run's stored ranking and counterfactual. */
export async function loadDonorOptions(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
  sigma?: SigmaVariant,
): Promise<{ options: DonorOption[]; seedNode: string; sigma: SigmaVariant }> {
  const version = canonicalise.POLICIES[policyId].version;
  const { observations, context, config } = await graph.loadRunGraphInputs(db, runId);
  const s = sigma ?? config.sigmaVariant;
  const rankings = await q.listArtefacts(db, runId, {
    kind: fixes.FIX_RANKING_ARTEFACT,
    policyVersion: version,
  });
  const ranking = rankings
    .map((r) => r.payload as unknown as fixes.FixRanking)
    .filter((r) => r.sigmaVariant === s)
    .at(-1);
  if (ranking === undefined)
    throw new Error(`run ${runId} has no ${version} fix ranking with σ ${s}`);
  const derived = graph.deriveGraphFromObservations(observations, policyId, context, config);
  const pr = new Map<string, number>();
  derived.graph.forEachNode((n, a) => pr.set(n, a.pagerank ?? 0));
  const { list } = await fixes.loadCandidates(db, runId, policyId, ranking.sources.refVariant);
  const section = new Map(list.candidates.map((c) => [c.id, c.section.relation === "same"]));
  return {
    sigma: s,
    seedNode: derived.summary.seedNode,
    options: ranking.fixes.map((f) => ({
      donor: f.donor,
      target: f.target,
      ref: f.ref,
      sameSection: section.get(f.id) ?? false,
      donorPagerank: pr.get(f.donor) ?? 0,
      deltaPr: f.deltaPr,
      deltaDepth: f.deltaDepth,
      targetRank: f.targetRank,
    })),
  };
}
