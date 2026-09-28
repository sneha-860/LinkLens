/**
 * GraphSAGE link-predictor scores (experimental; `config.graphsageEnabled`, off by default).
 * The model is trained offline (analysis/ml/gnn.py, PyTorch Geometric, leave-one-site-out: a
 * site's scores come from a model trained on the other sites' graphs) and imported per run as
 * a `graphsage-scores` artefact. E6 reads the masked repeats' scores as its "graphsage" method;
 * the L13 ranker reads them as a feature.
 */
export const GRAPHSAGE_VERSION = "graphsage@1.0.0";
export const GRAPHSAGE_ARTEFACT = "graphsage-scores";

/** One masked E6 repeat: for each target, its candidate donors and their scores. */
export interface GraphSageRepeat {
  readonly repeat: number;
  /** The seed E6 masked this repeat with (randomSeed + repeat). */
  readonly seed: number;
  /** Indices into `nodes`: target, then parallel candidate and score arrays. */
  readonly targets: readonly {
    readonly target: number;
    readonly donors: readonly number[];
    readonly scores: readonly number[];
  }[];
}

export interface GraphSageScores {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly model: {
    readonly site: string;
    readonly trainedOn: readonly string[];
    readonly params: Readonly<Record<string, number>>;
    readonly dataset: string;
    readonly createdAt: string;
    /** Training and scoring wall time for this site's fold, in ms. */
    readonly runtimeMs: Readonly<Record<string, number>>;
  };
  /** Sorted node URLs; every index above points here. */
  readonly nodes: readonly string[];
  readonly repeats: readonly GraphSageRepeat[];
  /** The unmasked site's fixes, by fix id (`${type}:${donor}->${target}`). */
  readonly fixes: Readonly<Record<string, number>>;
}

/** Pure: a (repeat, target, donor) → score lookup; undefined when the pair was not scored. */
export function graphsageLookup(
  s: Pick<GraphSageScores, "nodes" | "repeats">,
): (repeat: number, target: string, donor: string) => number | undefined {
  const byRepeat = new Map<number, Map<string, Map<string, number>>>();
  for (const r of s.repeats) {
    const targets = new Map<string, Map<string, number>>();
    for (const t of r.targets) {
      if (t.donors.length !== t.scores.length) {
        throw new Error(`graphsage repeat ${r.repeat}: donors and scores differ in length`);
      }
      const m = new Map<string, number>();
      t.donors.forEach((d, i) => m.set(s.nodes[d] as string, t.scores[i] as number));
      targets.set(s.nodes[t.target] as string, m);
    }
    byRepeat.set(r.repeat, targets);
  }
  return (repeat, target, donor) => byRepeat.get(repeat)?.get(target)?.get(donor);
}
