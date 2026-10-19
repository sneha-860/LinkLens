import type { FixFeatureRow, SiteGraph } from "./features.js";
import { GRAPHSAGE_VERSION, type GraphSageScores } from "./graphsage.js";
import { LEARNED_VERSION, type LearnedFix, type LearnedPriority } from "./learned.js";

/**
 * The contract between the pipeline's optional model stages (learnedScore, graphsageScore) and
 * the Python scorer, `python -m ml score` (analysis/ml/score.py). The pipeline writes one JSON
 * request, the scorer writes one JSON response; both carry `protocol`, so a mismatch is refused
 * rather than misread. Pure: the process handling lives in packages/api.
 *
 * The models are deployable fits (`python -m ml fit` / `gnn-fit`): trained on every labelled
 * corpus site, unlike the leave-one-site-out folds of the offline evaluation.
 */
export const SCORER_PROTOCOL = "linklens-scorer@1";

/** A deployable model as the scorer reports it (from its model.json and the files' hashes). */
export interface ScoringModelInfo {
  readonly kind: "ranker" | "graphsage";
  /** SHA-256 over "name\0sha256\n" of the model's files: the version of record. */
  readonly sha256: string;
  readonly files: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  /** The corpus sites it was fit on, and their hosts (to tell whether this site was seen). */
  readonly trainedOn: readonly string[];
  readonly trainedOnHosts: readonly string[];
  readonly labels: string;
  /** The training data's digest (dataset.json / graphs.json files). */
  readonly dataset: string;
  readonly createdAt: string;
  readonly features: readonly string[];
  readonly params: Readonly<Record<string, number>>;
}

export interface RankerRequest {
  readonly protocol: typeof SCORER_PROTOCOL;
  readonly kind: "ranker";
  /** The feature names in the order the rows were built (checked against the model's). */
  readonly features: readonly string[];
  readonly shapTop: number;
  readonly rows: readonly FixFeatureRow[];
}

export interface GraphSageRequest {
  readonly protocol: typeof SCORER_PROTOCOL;
  readonly kind: "graphsage";
  readonly nodes: readonly string[];
  readonly embeddingDim: number;
  readonly structural: readonly string[];
  /** SiteGraph.x as little-endian float32, base64. */
  readonly x: string;
  readonly src: readonly number[];
  readonly dst: readonly number[];
  /** The fixes to score: donor → target. */
  readonly pairs: readonly {
    readonly id: string;
    readonly donor: string;
    readonly target: string;
  }[];
}

export type ScorerRequest = RankerRequest | GraphSageRequest;

export interface RankerResponse {
  readonly protocol: typeof SCORER_PROTOCOL;
  readonly kind: "ranker";
  readonly model: ScoringModelInfo;
  readonly fixes: Readonly<Record<string, LearnedFix>>;
}

export interface GraphSageResponse {
  readonly protocol: typeof SCORER_PROTOCOL;
  readonly kind: "graphsage";
  readonly model: ScoringModelInfo;
  /** Logits by fix id; a pair with an end outside the graph is absent. */
  readonly scores: Readonly<Record<string, number>>;
}

/** Pure: the ranker request for a run's fix rows. */
export function rankerRequest(
  rows: readonly FixFeatureRow[],
  features: readonly string[],
  shapTop: number,
): RankerRequest {
  return { protocol: SCORER_PROTOCOL, kind: "ranker", features, shapTop, rows };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes → standard base64 (RFC 4648, padded). */
export function base64(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out.push(
      (B64[(n >> 18) & 63] as string) +
        (B64[(n >> 12) & 63] as string) +
        (b === undefined ? "=" : (B64[(n >> 6) & 63] as string)) +
        (c === undefined ? "=" : (B64[n & 63] as string)),
    );
  }
  return out.join("");
}

/** Little-endian float32 → base64, whatever the platform's byte order. */
export function float32Base64(x: Float32Array): string {
  const bytes = new Uint8Array(x.length * 4);
  const view = new DataView(bytes.buffer);
  x.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return base64(bytes);
}

/** Pure: the GraphSAGE request for a site graph and the fixes to score. */
export function graphsageRequest(
  g: SiteGraph,
  structural: readonly string[],
  pairs: GraphSageRequest["pairs"],
): GraphSageRequest {
  return {
    protocol: SCORER_PROTOCOL,
    kind: "graphsage",
    nodes: g.nodes,
    embeddingDim: g.embeddingDim,
    structural,
    x: float32Base64(g.x),
    src: g.src,
    dst: g.dst,
    pairs,
  };
}

/** The host of an absolute URL, lower-cased, without `www.`; null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Was the audited site among the model's training sites? Then its scores are in-sample (the model
 * saw its links as labels) and say less than on an unseen site; the payload records it.
 */
export function seenSite(
  model: Pick<ScoringModelInfo, "trainedOnHosts">,
  siteUrl: string,
): boolean {
  const h = hostOf(siteUrl);
  return h !== null && model.trainedOnHosts.some((t) => (hostOf(`https://${t}/`) ?? t) === h);
}

/** Refuse a response that is not for this request's protocol and kind. */
export function checkResponse<R extends RankerResponse | GraphSageResponse>(
  response: unknown,
  kind: R["kind"],
): R {
  const r = response as Partial<R> | null;
  if (r === null || typeof r !== "object" || r.protocol !== SCORER_PROTOCOL || r.kind !== kind) {
    throw new Error(`the scorer did not answer a ${SCORER_PROTOCOL} ${kind} response`);
  }
  if (r.model === undefined || typeof r.model.sha256 !== "string") {
    throw new Error("the scorer's response has no model hash");
  }
  return r as R;
}

/**
 * Pure: the `learned-priority` artefact payload of a pipeline-scored run. `model.site` is the
 * audited URL; `trainedOn` are the corpus sites the deployable model was fit on.
 */
export function learnedPayload(
  runId: number,
  policyVersion: string,
  siteUrl: string,
  r: RankerResponse,
): LearnedPriority {
  return {
    version: LEARNED_VERSION,
    runId,
    policyVersion,
    model: {
      site: siteUrl,
      trainedOn: [...r.model.trainedOn],
      labels: r.model.labels,
      features: [...r.model.features],
      params: r.model.params,
      dataset: r.model.dataset,
      createdAt: r.model.createdAt,
      source: "pipeline",
      sha256: r.model.sha256,
      seenSite: seenSite(r.model, siteUrl),
    },
    fixes: r.fixes,
  };
}

/**
 * Pure: the `graphsage-scores` artefact payload of a pipeline-scored run: the fixes' scores only
 * (no E6 repeats: those come from the offline leave-one-site-out run, `l13 graph-import`).
 */
export function graphsagePayload(
  runId: number,
  policyVersion: string,
  siteUrl: string,
  r: GraphSageResponse,
  runtimeMs: Readonly<Record<string, number>>,
): GraphSageScores {
  return {
    version: GRAPHSAGE_VERSION,
    runId,
    policyVersion,
    model: {
      site: siteUrl,
      trainedOn: [...r.model.trainedOn],
      params: r.model.params,
      dataset: r.model.dataset,
      createdAt: r.model.createdAt,
      runtimeMs,
      source: "pipeline",
      sha256: r.model.sha256,
      seenSite: seenSite(r.model, siteUrl),
    },
    nodes: [],
    repeats: [],
    fixes: r.scores,
  };
}
