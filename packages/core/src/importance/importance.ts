import type { LinkLensConfig, PageType } from "../config.js";
import type { LinkGraph } from "../graph/build.js";
import { regionClass } from "../prominence/weights.js";
import { classifyPage, compileRules, countWords, type PageSignals } from "./page-type.js";

/** Bump whenever the page types or the importance values can change. */
export const IMPORTANCE_VERSION = "importance@1.0.0";
export const IMPORTANCE_ARTEFACT = "page-importance";

/**
 * Page importance (L12): how much a page is worth linking to, in [0, 1]:
 *
 *   importance(v) = Σ_i w_i·x_i(v) / Σ_i w_i
 *
 * - x_type: the page-type prior (`pageTypePriors`) of its rule-based type (`classifyPage`);
 * - x_pr: its PageRank percentile among the graph's nodes (mid-rank, so ties share a value);
 * - x_depth: 1 / (1 + BFS depth from the homepage), 0 when unreachable;
 * - x_in: ln(1 + inbound main-content links) / ln(1 + the site's largest such count).
 *
 * The weights (`importanceWeights`) and priors are **heuristic**: our judgement, not fitted to
 * any outcome. The fix ranking only uses importance when `fixScoring` is "S_imp".
 */

export interface ImportanceComponents {
  readonly typePrior: number;
  readonly pagerank: number;
  readonly depth: number;
  readonly inboundBodyLinks: number;
}

export interface NodeImportance {
  readonly type: PageType;
  readonly rule: string;
  readonly evidence: string;
  readonly importance: number;
  /** Each x_i in [0, 1], before weighting. */
  readonly components: ImportanceComponents;
  /** The raw values behind them. */
  readonly raw: {
    readonly pagerank: number;
    readonly depth: number | null;
    readonly inboundBodyLinks: number;
  };
  readonly schemaTypes: string[];
}

export interface PageImportance {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly weights: LinkLensConfig["importanceWeights"];
  readonly priors: LinkLensConfig["pageTypePriors"];
  readonly counts: Record<PageType, number>;
  /** Every node of the policy's graph, sorted. */
  readonly nodes: Record<string, NodeImportance>;
}

export interface ImportanceInput {
  readonly runId: number;
  readonly policyVersion: string;
  /** The policy's derived graph (metrics attached) and its seed node. */
  readonly graph: LinkGraph;
  readonly seedNode: string;
  /** Main-content text per representative fetch id. */
  readonly bodyText: (fetchId: number) => string | null;
  /** schema.org types per representative fetch id (empty when its HTML is not stored). */
  readonly schemaTypes: (fetchId: number) => readonly string[];
}

const PAGINATION_REL = /\b(next|prev|previous)\b/i;

/** One of a page's outgoing links, as the classifier needs it. */
export interface SignalLink {
  readonly domRegion: string | null;
  readonly anchorText: string | null;
  readonly rel: string | null;
}

/**
 * Pure: a page's classifier signals from its text, schema.org types and outgoing (internal)
 * links: main-content links (dom_region main/body) and their anchor words, and pagination (a
 * pagination block, or a rel=next/prev link).
 */
export function pageSignals(page: {
  readonly url: string;
  readonly isSeed: boolean;
  readonly crawled: boolean;
  readonly bodyText: string | null;
  readonly schemaTypes: readonly string[];
  readonly links: readonly SignalLink[];
}): PageSignals {
  let bodyLinks = 0;
  let bodyLinkWords = 0;
  let pagination = false;
  for (const l of page.links) {
    if (l.domRegion === "pagination" || (l.rel !== null && PAGINATION_REL.test(l.rel))) {
      pagination = true;
    }
    if (regionClass(l.domRegion) === "body") {
      bodyLinks += 1;
      bodyLinkWords += countWords(l.anchorText);
    }
  }
  return {
    url: page.url,
    isSeed: page.isSeed,
    schemaTypes: page.schemaTypes,
    crawled: page.crawled,
    bodyWords: page.crawled ? countWords(page.bodyText) : 0,
    bodyLinks,
    bodyLinkWords,
    pagination,
  };
}

/** Pure: the signals the classifier sees for one node of the graph (its out-links). */
export function nodeSignals(input: ImportanceInput, node: string): PageSignals {
  const g = input.graph;
  const a = g.getNodeAttributes(node);
  const fetchId = a.representativeFetchId;
  const links: SignalLink[] = [];
  g.forEachOutEdge(node, (_e, e) => links.push(e));
  return pageSignals({
    url: node,
    isSeed: node === input.seedNode,
    crawled: a.crawled && fetchId !== null,
    bodyText: fetchId === null ? null : input.bodyText(fetchId),
    schemaTypes: fetchId === null ? [] : input.schemaTypes(fetchId),
    links,
  });
}

/** Mid-rank percentile of each value among all of them: (below + ½·equal) / n. */
export function percentiles(values: readonly number[]): number[] {
  const sorted = [...values].sort((x, y) => x - y);
  const firstAt = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const lastAt = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] as number) <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return values.map((v) => {
    const below = firstAt(v);
    const equal = lastAt(v) - below;
    return (below + equal / 2) / values.length;
  });
}

/**
 * Pure: importance of a page that is not a node of the graph (an orphan: nothing links to it and
 * it is unreachable), by the same formula: its PageRank percentile, depth and inbound-link
 * components are 0, so only its URL-based type prior counts.
 */
export function detachedImportance(
  url: string,
  config: Pick<LinkLensConfig, "pageTypeRules" | "pageTypePriors" | "importanceWeights">,
  schema: readonly string[] = [],
): Pick<NodeImportance, "type" | "rule" | "evidence" | "importance" | "components"> {
  const t = classifyPage(
    {
      url,
      isSeed: false,
      schemaTypes: schema,
      crawled: false,
      bodyWords: 0,
      bodyLinks: 0,
      bodyLinkWords: 0,
      pagination: false,
    },
    compileRules(config.pageTypeRules),
  );
  const w = config.importanceWeights;
  const components = {
    typePrior: config.pageTypePriors[t.type],
    pagerank: 0,
    depth: 0,
    inboundBodyLinks: 0,
  };
  return {
    type: t.type,
    rule: t.rule,
    evidence: t.evidence,
    components,
    importance:
      (w.typePrior * components.typePrior) /
      (w.typePrior + w.pagerank + w.depth + w.inboundBodyLinks),
  };
}

/** Pure: page type and importance of every node of the graph. */
export function computeImportance(
  input: ImportanceInput,
  config: Pick<LinkLensConfig, "pageTypeRules" | "pageTypePriors" | "importanceWeights">,
): PageImportance {
  const compiled = compileRules(config.pageTypeRules);
  const g = input.graph;
  const nodes = [...g.nodes()].sort();
  const inbound = new Map<string, number>();
  g.forEachEdge((_e, e, _s, target) => {
    if (regionClass(e.domRegion) === "body") inbound.set(target, (inbound.get(target) ?? 0) + 1);
  });
  const maxIn = Math.max(0, ...inbound.values());
  const prs = nodes.map((n) => g.getNodeAttribute(n, "pagerank") ?? 0);
  const prPct = percentiles(prs);
  const w = config.importanceWeights;
  const wSum = w.typePrior + w.pagerank + w.depth + w.inboundBodyLinks;

  const counts = { homepage: 0, hub: 0, product: 0, article: 0, utility: 0, other: 0 } as Record<
    PageType,
    number
  >;
  const out: Record<string, NodeImportance> = {};
  nodes.forEach((node, i) => {
    const signals = nodeSignals(input, node);
    const t = classifyPage(signals, compiled);
    counts[t.type] += 1;
    const depth = g.getNodeAttribute(node, "depth") ?? null;
    const links = inbound.get(node) ?? 0;
    const components: ImportanceComponents = {
      typePrior: config.pageTypePriors[t.type],
      pagerank: prPct[i] as number,
      depth: depth === null ? 0 : 1 / (1 + depth),
      inboundBodyLinks: maxIn === 0 ? 0 : Math.log1p(links) / Math.log1p(maxIn),
    };
    const importance =
      (w.typePrior * components.typePrior +
        w.pagerank * components.pagerank +
        w.depth * components.depth +
        w.inboundBodyLinks * components.inboundBodyLinks) /
      wSum;
    out[node] = {
      type: t.type,
      rule: t.rule,
      evidence: t.evidence,
      importance,
      components,
      raw: { pagerank: prs[i] as number, depth, inboundBodyLinks: links },
      schemaTypes: [...signals.schemaTypes],
    };
  });
  return {
    version: IMPORTANCE_VERSION,
    runId: input.runId,
    policyVersion: input.policyVersion,
    weights: config.importanceWeights,
    priors: config.pageTypePriors,
    counts,
    nodes: out,
  };
}
