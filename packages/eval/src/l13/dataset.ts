import {
  canonicalise,
  db as q,
  fixes,
  rating,
  semantic,
  text,
  type LinkLensConfig,
} from "@linklens/core";
import type { Embedder } from "@linklens/embeddings";
import { buildE3Inputs, type E3Data } from "../e3-baselines.js";
import { editorialSite, maskSite, maskedInputs } from "../e6-masking.js";
import { prepareRun, type PreparedRun, type RunInputs } from "../in-memory.js";
import {
  detachedFacts,
  jaccardOf,
  nodeFacts,
  pairFeatures,
  sScore,
  type NodeFacts,
  type PairFeatures,
} from "./features.js";

type PolicyId = canonicalise.PolicyId;

/**
 * L13 training and scoring rows for one audited run.
 *
 * - E6 rows (labels): for each of `l13Repeats` masked repeats (E6's own masking: seeds randomSeed
 *   + r), each masked link u* → v is a query; its candidates are E6's (every page with text but v,
 *   pages still linking to v, and v's other masked donors); label 1 for u*, 0 for the others. The
 *   features are measured in the masked site: its graph, prominence, κ, PageRank and depths, its
 *   rebuilt text model (REF, Jaccard) and embeddings (cosine), and ΔPR / depth gain simulated on
 *   it. So the positive's own link and anchor are gone from every feature.
 * - Fix rows: the run's fixes (the default ranking, reproduced in memory) with the same features
 *   on the unmasked site: what the "learned" mode will score.
 * - Pool rows: E3's pool (weak-authority fix candidates and orphan rescue donors), for the E3
 *   comparison. An orphan target is not a graph node: its facts are detached (L12).
 * - Rating rows: E8 answers when a rating sample exists: the mean relevance of the raters.
 *
 * Every row carries S (ΔPR × σ_refGateCosine / κ) and the hybrid σ as baselines, not features.
 */

export interface E6Row extends PairFeatures {
  readonly repeat: number;
  readonly query: string;
  readonly target: string;
  readonly donor: string;
  readonly label: 0 | 1;
  readonly s_score: number;
  readonly sigma_hybrid: number;
}

export interface FixRow extends PairFeatures {
  readonly fix_id: string;
  readonly donor: string;
  readonly target: string;
  readonly type: string;
  readonly rank_s: number;
  readonly s_score: number;
}

export interface PoolRow extends PairFeatures {
  readonly entry_id: string;
  readonly donor: string;
  readonly target: string;
  readonly kind: string;
  readonly s_score: number;
}

export interface RatingRow extends PairFeatures {
  readonly fix_id: string;
  readonly raters: number;
  /** Mean of the raters' relevant (1) / not relevant (0). */
  readonly relevance: number;
  readonly s_score: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Each prominence edge's ω, by "u\\u0000v". */
const omegaMap = (edges: readonly { source: string; target: string; omega: number }[]) =>
  new Map(edges.map((e) => [`${e.source}\u0000${e.target}`, e.omega]));

/** The facts of a node that must exist (a document is always a graph node). */
const factsOf = (facts: (n: string) => NodeFacts | undefined, n: string): NodeFacts => {
  const f = facts(n);
  if (f === undefined) throw new Error(`${n} is not a node of the graph`);
  return f;
};

/** E6 label rows: `l13Repeats` masked repeats, every query's candidates with features. */
export async function e6Rows(
  inputs: RunInputs,
  policyId: PolicyId,
  embedder: Embedder,
): Promise<E6Row[]> {
  const { config } = inputs;
  const site = editorialSite(inputs, policyId);
  const out: E6Row[] = [];
  for (let r = 0; r < config.l13Repeats; r++) {
    const m = maskSite(inputs, site, config.randomSeed + r, config);
    const prepared = prepareRun({ ...maskedInputs(inputs, m), cosine: null }, { policyId });
    const st = prepared.state;
    const facts = nodeFacts(st.graph, prepared.importance().nodes);
    const toEmbed = m.documents.map(semantic.embeddingInput).sort((a, b) => cmp(a.node, b.node));
    const { vectors } = await embedder.embed(toEmbed.map(({ title, body }) => ({ title, body })));
    const vector = new Map(toEmbed.map((d, i) => [d.node, vectors[i] as Float32Array]));
    const cosine = (u: string, v: string): number | null => {
      const a = vector.get(u);
      const b = vector.get(v);
      if (a === undefined || b === undefined) return null;
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += (a[k] as number) * (b[k] as number);
      return dot;
    };
    const docs = [...st.model.documents].sort((a, b) => cmp(a.node, b.node));
    const byNode = new Map(docs.map((d) => [d.node, d]));
    const donorSet = new Map(docs.map((d) => [d.node, new Set(d.donor)]));
    const omega = omegaMap(st.prominence.edges);
    const byTarget = new Map<string, string[]>();
    for (const x of m.masked) {
      if (!byNode.has(x.donor) || !byNode.has(x.target)) continue;
      byTarget.set(x.target, [...(byTarget.get(x.target) ?? []), x.donor]);
    }
    for (const [target, maskedDonors] of [...byTarget].sort((a, b) => cmp(a[0], b[0]))) {
      const tw = semantic.targetWeights(byNode.get(target) as text.TextDocument);
      const targetTerms = new Set(tw.keys());
      const pool = docs
        .map((d) => d.node)
        .filter((u) => u !== target && !st.graph.hasDirectedEdge(u, target));
      // Each candidate's features once per target, shared by the target's queries.
      const rows = new Map<string, { f: PairFeatures; s: number; hybrid: number }>();
      for (const u of pool) {
        const res = fixes.simulate(
          st.weighted,
          st.base,
          {
            id: `${u}->${target}`,
            donor: st.index.get(u) as number,
            target: st.index.get(target) as number,
            action: "add-link",
          },
          config.prominenceRegionWeights.body,
          config,
          true,
          st.workspace,
        );
        const ref = semantic.ref(donorSet.get(u) as Set<string>, tw, "weighted");
        const cos = cosine(u, target);
        const effort = st.effort.get(u) ?? { kappa: 1, templateReach: 1 };
        const f = pairFeatures({
          donor: u,
          target,
          deltaPr: res.deltaPrTarget,
          depthBefore: res.depthBefore,
          depthAfter: res.depthAfter,
          ref,
          cosine: cos,
          jaccard: jaccardOf(donorSet.get(u) as Set<string>, targetTerms),
          omega: omega.get(`${u}\u0000${target}`) ?? 0,
          kappa: effort.kappa,
          templateReach: effort.templateReach,
          donorFacts: factsOf(facts, u),
          targetFacts: factsOf(facts, target),
        });
        rows.set(u, {
          f,
          s: sScore(res.deltaPrTarget, ref, cos, effort.kappa, config),
          hybrid: fixes.sigmaValues(ref, cos, config).refGateCosine,
        });
      }
      for (const donor of maskedDonors) {
        const others = new Set(maskedDonors.filter((x) => x !== donor));
        const candidates = pool.filter((u) => !others.has(u));
        if (!candidates.includes(donor)) continue; // still linked through an unmasked observation
        const query = `${r}|${target}|${donor}`;
        for (const u of candidates) {
          const row = rows.get(u) as { f: PairFeatures; s: number; hybrid: number };
          out.push({
            repeat: r,
            query,
            target,
            donor: u,
            label: u === donor ? 1 : 0,
            s_score: row.s,
            sigma_hybrid: row.hybrid,
            ...row.f,
          });
        }
      }
    }
  }
  return out;
}

/** The unmasked site prepared once: its fixes (the default ranking) and feature lookups. */
export interface SiteFeatures {
  readonly prepared: PreparedRun;
  readonly ranked: fixes.FixRecord[];
  readonly facts: (n: string) => NodeFacts | undefined;
  readonly donorSet: Map<string, Set<string>>;
  readonly targetTerms: Map<string, Set<string>>;
  readonly omega: Map<string, number>;
}

export function siteFeatures(inputs: RunInputs, policyId: PolicyId): SiteFeatures {
  const { config } = inputs;
  const prepared = prepareRun(inputs, { policyId });
  const st = prepared.state;
  const ranked = prepared.rank({
    epsilon: config.epsilon,
    alpha: config.alpha,
    sigma: config.sigmaVariant,
    scoring: "S",
  });
  return {
    prepared,
    ranked,
    facts: nodeFacts(st.graph, prepared.importance().nodes),
    donorSet: new Map(st.model.documents.map((d) => [d.node, new Set(d.donor)])),
    targetTerms: new Map(
      st.model.documents.map((d) => [d.node, new Set(semantic.targetWeights(d).keys())]),
    ),
    omega: omegaMap(st.prominence.edges),
  };
}

/** Fix rows: every fix of the default ranking with its features (what "learned" scores). */
export function fixRows(sf: SiteFeatures, config: Readonly<LinkLensConfig>): FixRow[] {
  return sf.ranked.map((f) => ({
    fix_id: f.id,
    donor: f.donor,
    target: f.target,
    type: f.type,
    rank_s: f.rank,
    s_score: sScore(f.deltaPr, f.ref, f.cosine, f.kappa, config),
    ...pairFeatures({
      donor: f.donor,
      target: f.target,
      deltaPr: f.deltaPr,
      depthBefore: f.depthBefore,
      depthAfter: f.depthAfter,
      ref: f.ref,
      cosine: f.cosine,
      jaccard: jaccardOf(
        sf.donorSet.get(f.donor) ?? new Set(),
        sf.targetTerms.get(f.target) ?? new Set(),
      ),
      omega: f.prominence.omega ?? 0,
      kappa: f.kappa,
      templateReach: f.templateReach,
      donorFacts: factsOf(sf.facts, f.donor),
      targetFacts: factsOf(sf.facts, f.target),
    }),
  }));
}

/** Pool rows: E3's pool at the run's ε, α and σ, with features (orphan targets detached). */
export function poolRows(
  sf: SiteFeatures,
  e3: E3Data,
  config: Readonly<LinkLensConfig>,
): PoolRow[] {
  const e3Inputs = buildE3Inputs(e3, {
    epsilon: config.epsilon,
    alpha: config.alpha,
    sigma: config.sigmaVariant,
  });
  const rescueIndex = new Map(e3Inputs.graph.nodes.map((n, i) => [n, i]));
  const model = e3.rescue.model;
  const orphanTerms = new Map<string, Set<string>>();
  for (const o of e3.rescue.orphans) {
    if (o.page === null) continue;
    orphanTerms.set(o.node, new Set(fixes.externalTargetWeights(o.page, model).keys()));
  }
  return e3Inputs.pool.map((e) => {
    const single = e3.singles.get(e.id);
    const target =
      sf.facts(e.target) ??
      detachedFacts(e.target, e3.base.rank[rescueIndex.get(e.target) as number] ?? 0, config);
    const effort = e3.effort.get(e.donor) ?? { kappa: e.kappa, templateReach: 1 };
    return {
      entry_id: e.id,
      donor: e.donor,
      target: e.target,
      kind: e.kind,
      s_score: sScore(e.deltaPr, e.ref, e.cosine, e.kappa, config),
      ...pairFeatures({
        donor: e.donor,
        target: e.target,
        deltaPr: e.deltaPr,
        depthBefore: single?.depthBefore ?? null,
        depthAfter: single?.depthAfter ?? null,
        ref: e.ref,
        cosine: e.cosine,
        jaccard: jaccardOf(
          sf.donorSet.get(e.donor) ?? new Set(),
          sf.targetTerms.get(e.target) ?? orphanTerms.get(e.target) ?? new Set(),
        ),
        omega: sf.omega.get(`${e.donor}\u0000${e.target}`) ?? 0,
        kappa: e.kappa,
        templateReach: effort.templateReach,
        donorFacts: factsOf(sf.facts, e.donor),
        targetFacts: target,
      }),
    };
  });
}

/** Rating rows (E8): each rated fix of the latest rating sample, with the raters' mean relevance. */
export async function ratingRows(
  db: q.Queryable,
  runId: number,
  policyId: PolicyId,
  fixes: readonly FixRow[],
): Promise<RatingRow[]> {
  const sample = await rating.loadRatingSample(db, runId, policyId);
  if (sample === null) return [];
  const answers = rating.latestAnswers(await q.listFixRatings(db, sample.artefactId));
  const byId = new Map(fixes.map((f) => [f.fix_id, f]));
  const out: RatingRow[] = [];
  for (const item of sample.items) {
    const votes = [...answers.values()]
      .map((m) => m.get(item.itemId))
      .filter((a): a is rating.Answer => a !== undefined);
    const f = byId.get(item.itemId);
    if (votes.length === 0 || f === undefined) continue;
    const { fix_id: _id, donor: _d, target: _t, type: _ty, rank_s: _r, s_score, ...features } = f;
    out.push({
      fix_id: item.itemId,
      raters: votes.length,
      relevance: votes.filter((a) => a.relevant).length / votes.length,
      s_score,
      ...features,
    });
  }
  return out;
}
