import { mulberry32 } from "../graph/random.js";

/**
 * MinHash signatures and an LSH Ensemble index for containment search (Zhu, Nargesian, Pu and
 * Miller, "LSH Ensemble: Internet-Scale Domain Search", VLDB 2016), used as a REF pre-filter:
 * the indexed sets are donors' S_A, a query is a target's S_B, and the candidates are the donors
 * whose containment |S_B ∩ S_A| / |S_B| may reach the threshold t*.
 *
 * - MinHash: each term is hashed to 32 bits (FNV-1a, then murmur3's fmix32); hash function i is
 *   simple tabulation, T_i0[byte 0] ⊕ T_i1[byte 1] ⊕ T_i2[byte 2] ⊕ T_i3[byte 3], with random
 *   tables drawn from randomSeed. Tabulation is close to min-wise independent (Pătraşcu and
 *   Thorup, "The Power of Simple Tabulation Hashing", 2012), so P(equal minima) ≈ Jaccard; a
 *   seeded mix such as fmix32(h ⊕ seed_i) is not (it hit 0.85 where 0.97 was predicted).
 * - Partitions: the indexed sets are split into equi-depth partitions by size; each partition's
 *   largest size u stands in for |S_A| when containment is turned into a Jaccard threshold,
 *   J = x·q / (u + q − x·q) for containment x and query size q (a lower bound on the true J).
 * - Per partition, one banded index per row count r = 1…maxRows (b = ⌊numPerm / r⌋ bands). A
 *   query picks, per partition, the (b, r) with b·r ≤ numPerm and r ≤ maxRows that minimises
 *   wFP·∫₀^t* P(x) dx + wFN·∫_t*^1 (1 − P(x)) dx, with P(x) = 1 − (1 − J(x)^r)^b, and looks up
 *   the first b bands of the r index.
 * - A partition whose largest set is smaller than t*·q cannot contain the query and is skipped
 *   (exact pruning).
 */

export interface LshParams {
  readonly numPerm: number;
  readonly partitions: number;
  readonly maxRows: number;
  readonly falsePositiveWeight: number;
  readonly falseNegativeWeight: number;
  readonly seed: number;
}

// ---------- hashing and MinHash ----------

/** murmur3's 32-bit finaliser: a bijection with good avalanche. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A term's 32-bit hash: FNV-1a over its UTF-16 code units, then fmix32. */
export function hashTerm(term: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** numPerm simple-tabulation hash functions: four 256-entry tables each (1024 words apart). */
export interface HashFamily {
  readonly numPerm: number;
  readonly tables: Uint32Array;
}

/** A hash family drawn from `seed` (the same seed gives the same family). */
export function hashFamily(numPerm: number, seed: number): HashFamily {
  const random = mulberry32(seed);
  const tables = new Uint32Array(numPerm * 1024);
  for (let i = 0; i < tables.length; i++) tables[i] = Math.floor(random() * 4294967296) >>> 0;
  return { numPerm, tables };
}

/** The MinHash signature of a set of term hashes; an empty set gives all 0xffffffff. */
export function minhash(hashes: ArrayLike<number>, family: HashFamily): Uint32Array {
  const { numPerm, tables } = family;
  const sig = new Uint32Array(numPerm).fill(0xffffffff);
  for (let j = 0; j < hashes.length; j++) {
    const h = hashes[j] as number;
    const b0 = h & 0xff;
    const b1 = 256 + ((h >>> 8) & 0xff);
    const b2 = 512 + ((h >>> 16) & 0xff);
    const b3 = 768 + (h >>> 24);
    for (let i = 0, base = 0; i < numPerm; i++, base += 1024) {
      const v =
        ((tables[base + b0] as number) ^
          (tables[base + b1] as number) ^
          (tables[base + b2] as number) ^
          (tables[base + b3] as number)) >>>
        0;
      if (v < (sig[i] as number)) sig[i] = v;
    }
  }
  return sig;
}

/** The key of rows [start, start + r) of a signature (a 32-bit mix; collisions only add candidates). */
function bandKey(sig: Uint32Array, start: number, r: number): number {
  let h = 0x9e3779b9 ^ r;
  for (let i = start; i < start + r; i++) h = fmix32(Math.imul(h, 31) ^ (sig[i] as number));
  return h;
}

// ---------- tuning (b, r) ----------

/** Simpson intervals per integral (even); the curves are smooth, so this is plenty. */
const SIMPSON_STEPS = 32;
/** Size ratios q/u are cached in log bins of this width (rounded down, i.e. a lower threshold). */
const RATIO_BIN = Math.log(1.01);

export interface BandParams {
  readonly b: number;
  readonly r: number;
}

/**
 * The (b, r) minimising the weighted false-positive and false-negative areas for containment
 * threshold t, when the query is `ratio` = q/u times the largest indexed set.
 */
export function optimalBands(
  t: number,
  ratio: number,
  params: Pick<LshParams, "numPerm" | "maxRows" | "falsePositiveWeight" | "falseNegativeWeight">,
): BandParams {
  // Containment x → the Jaccard lower bound at the partition's largest set size. A query larger
  // than that set (ratio > 1) cannot be contained beyond u/q = 1/ratio, so both areas stop there.
  const jaccard = (x: number) => Math.min(1, (x * ratio) / (1 + ratio - x * ratio));
  const top = Math.min(1, 1 / ratio);
  const n = SIMPSON_STEPS;
  const xs: number[] = [];
  const ws: number[] = [];
  const side = (lo: number, hi: number, fp: boolean) => {
    if (hi <= lo) return;
    const h = (hi - lo) / n;
    for (let i = 0; i <= n; i++) {
      xs.push(lo + i * h);
      const simpson = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2;
      const w = (h / 3) * simpson * (fp ? params.falsePositiveWeight : -params.falseNegativeWeight);
      ws.push(w);
    }
  };
  side(0, Math.min(t, top), true);
  side(t, top, false);
  // cost = wFP·∫P over [0,t] + wFN·∫(1 − P) over [t,top] = Σ w·P + wFN·(top − t).
  const constant = params.falseNegativeWeight * Math.max(0, top - t);
  const js = xs.map(jaccard);
  let best: BandParams = { b: 1, r: 1 };
  let bestCost = Infinity;
  const miss = new Float64Array(xs.length);
  const bandMiss = new Float64Array(xs.length);
  for (let r = 1; r <= params.maxRows; r++) {
    const bands = Math.floor(params.numPerm / r);
    // One band misses with probability 1 − J^r; miss[i] = (1 − J^r)^b, updated as b grows.
    for (let i = 0; i < xs.length; i++) {
      miss[i] = 1;
      bandMiss[i] = 1 - (js[i] as number) ** r;
    }
    for (let b = 1; b <= bands; b++) {
      let cost = constant;
      for (let i = 0; i < xs.length; i++) {
        miss[i] = (miss[i] as number) * (bandMiss[i] as number);
        cost += (ws[i] as number) * (1 - (miss[i] as number));
      }
      if (cost < bestCost - 1e-12) {
        bestCost = cost;
        best = { b, r };
      }
    }
  }
  return best;
}

// ---------- the index ----------

interface Partition {
  /** Indexed ids, in index order. */
  readonly ids: number[];
  readonly lower: number;
  readonly upper: number;
  /** tables[r - 1][band]: band key → ids. */
  readonly tables: Map<number, number[]>[][];
}

export interface LshEnsemble {
  readonly params: LshParams;
  readonly family: HashFamily;
  readonly partitions: Partition[];
  /**
   * Tuned (b, r) per (size-ratio bin, threshold), shared by the partitions (the ratio q/u is all
   * the tuning depends on): filled lazily by queries.
   */
  readonly tuned: Map<string, BandParams>;
  /** Query scratch: seen[id] === stamp marks an id already found by the current query. */
  readonly seen: Int32Array;
  stamp: number;
}

/**
 * Index sets (given as term hashes; id = position) into an LSH Ensemble. Signatures can be
 * passed when already computed (the experiment times them separately).
 */
export function buildLshEnsemble(
  sets: readonly ArrayLike<number>[],
  params: LshParams,
  signatures?: readonly Uint32Array[],
): LshEnsemble {
  const family = hashFamily(params.numPerm, params.seed);
  const sigs = signatures ?? sets.map((s) => minhash(s, family));
  // Equi-depth partitions by size (ties by id); empty sets can never contain a query.
  const order = sets
    .map((s, id) => ({ id, size: s.length }))
    .filter((x) => x.size > 0)
    .sort((a, b) => a.size - b.size || a.id - b.id);
  const k = Math.max(1, Math.min(params.partitions, order.length));
  const partitions: Partition[] = [];
  for (let p = 0; p < k; p++) {
    const slice = order.slice(
      Math.floor((p * order.length) / k),
      Math.floor(((p + 1) * order.length) / k),
    );
    if (slice.length === 0) continue;
    const tables: Map<number, number[]>[][] = [];
    for (let r = 1; r <= params.maxRows; r++) {
      const bands = Math.floor(params.numPerm / r);
      const byBand: Map<number, number[]>[] = [];
      for (let band = 0; band < bands; band++) {
        const table = new Map<number, number[]>();
        for (const { id } of slice) {
          const key = bandKey(sigs[id] as Uint32Array, band * r, r);
          const list = table.get(key);
          if (list === undefined) table.set(key, [id]);
          else list.push(id);
        }
        byBand.push(table);
      }
      tables.push(byBand);
    }
    partitions.push({
      ids: slice.map((x) => x.id),
      lower: (slice[0] as { size: number }).size,
      upper: (slice[slice.length - 1] as { size: number }).size,
      tables,
    });
  }
  return {
    params,
    family,
    partitions,
    tuned: new Map(),
    seen: new Int32Array(sets.length),
    stamp: 0,
  };
}

/**
 * Ids whose sets may contain at least `threshold` of the query (containment |Q ∩ X| / |Q|),
 * sorted. `signature` is the query's MinHash (minhash(query hashes, index.family)) and `size` |Q|.
 */
export function queryLshEnsemble(
  index: LshEnsemble,
  signature: Uint32Array,
  size: number,
  threshold: number,
): number[] {
  if (size === 0) return [];
  const found: number[] = [];
  const { seen } = index;
  index.stamp += 1;
  const stamp = index.stamp;
  for (const part of index.partitions) {
    // |Q ∩ X| ≤ |X| ≤ upper, so containment ≥ t needs upper ≥ t·q.
    if (part.upper < threshold * size) continue;
    const bin = Math.floor(Math.log(size / part.upper) / RATIO_BIN);
    const key = `${bin}:${threshold}`;
    let bands = index.tuned.get(key);
    if (bands === undefined) {
      bands = optimalBands(threshold, Math.exp(bin * RATIO_BIN), index.params);
      index.tuned.set(key, bands);
    }
    const tables = part.tables[bands.r - 1] as Map<number, number[]>[];
    for (let band = 0; band < bands.b; band++) {
      const ids = (tables[band] as Map<number, number[]>).get(
        bandKey(signature, band * bands.r, bands.r),
      );
      if (ids === undefined) continue;
      for (const id of ids) {
        if (seen[id] !== stamp) {
          seen[id] = stamp;
          found.push(id);
        }
      }
    }
  }
  return found.sort((a, b) => a - b);
}

/** The fraction of pairs a (b, r) band scheme returns at Jaccard similarity s. */
export const collisionProbability = (s: number, { b, r }: BandParams) => 1 - (1 - s ** r) ** b;
