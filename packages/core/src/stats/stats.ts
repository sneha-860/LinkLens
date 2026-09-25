/** Jaccard similarity of two sets (1 when both are empty). */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const union = new Set([...a, ...b]).size;
  if (union === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / union;
}

/** 1-based ranks, ties sharing their average rank. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const ranks = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.[0] === order[i]?.[0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[(order[k] as readonly [number, number])[1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation of two maps over their common keys (Pearson on average ranks,
 * so ties are handled); null with fewer than two common keys or no variation.
 */
export function spearman(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number | null {
  const keys = [...a.keys()].filter((k) => b.has(k)).sort();
  if (keys.length < 2) return null;
  const ra = averageRanks(keys.map((k) => a.get(k) as number));
  const rb = averageRanks(keys.map((k) => b.get(k) as number));
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < keys.length; i++) {
    const x = (ra[i] as number) - ma;
    const y = (rb[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

/**
 * Depth shift of a policy against the baseline over pages reachable under both: the mean
 * signed shift (policy − baseline) and the mean absolute shift; null when none are common.
 */
export function depthShift(
  policy: ReadonlyMap<string, number>,
  baseline: ReadonlyMap<string, number>,
): { mean: number; meanAbs: number; pages: number } | null {
  let n = 0;
  let sum = 0;
  let abs = 0;
  for (const [k, d] of policy) {
    const b = baseline.get(k);
    if (b === undefined) continue;
    n += 1;
    sum += d - b;
    abs += Math.abs(d - b);
  }
  return n === 0 ? null : { mean: sum / n, meanAbs: abs / n, pages: n };
}

export const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Ranking metrics for recovery experiments, from the 1-based rank at which each sought item was
 * found (null = not found): mean reciprocal rank, and recall@k for each k.
 */
export function rankingMetrics(
  ranks: readonly (number | null)[],
  ks: readonly number[],
): { n: number; mrr: number | null; recall: Record<number, number | null> } {
  const n = ranks.length;
  const recall: Record<number, number | null> = {};
  for (const k of ks) {
    recall[k] = n === 0 ? null : ranks.filter((r) => r !== null && r <= k).length / n;
  }
  return { n, mrr: mean(ranks.map((r) => (r === null ? 0 : 1 / r))), recall };
}
