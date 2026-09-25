import type { LinkLensConfig } from "../config.js";
import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import { insertArtefact, listFetches, listPages } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import type { DiscoveryChannel } from "../discovery/channels.js";
import { reconcile, type InventoryEntry, type Reconciliation } from "../discovery/reconcile.js";
import { listDiscoveryObservations } from "../db/queries.js";
import type { LinkGraph } from "../graph/build.js";
import { deriveGraphFromObservations, loadRunGraphInputs } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import { resolveReference } from "../url/rfc3986.js";

export const STRUCTURAL_AUDIT_ARTEFACT = "structural-audit";

export const ISSUE_TYPES = [
  "orphan",
  "deep-page",
  "weak-authority",
  "outside-largest-scc",
  "dead-end",
  "noindex-nofollow-conflict",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Rules under the noindex-nofollow-conflict type. */
export type ConflictRule =
  "noindex-in-sitemap" | "canonical-to-noindex" | "nofollow-sole-path" | "internal-nofollow";

export interface Issue {
  /** Stable id: `${type}[:${rule}]:${node}`. */
  readonly id: string;
  readonly type: IssueType;
  readonly rule?: ConflictRule;
  readonly node: string;
  readonly severity: Severity;
  /** The values the rule looked at, so the issue can be explained and re-checked. */
  readonly evidence: { readonly [key: string]: Json };
  readonly policyVersion: string;
}

export interface AuditSummary {
  readonly runId: number;
  readonly policyVersion: string;
  readonly total: number;
  readonly byType: Record<IssueType, number>;
  readonly bySeverity: Record<Severity, number>;
  /** Conflict issues per rule. */
  readonly byRule: Record<ConflictRule, number>;
  /** Distinct nodes with at least one issue. */
  readonly nodesWithIssues: number;
  /** Crawled pages audited (denominator for page-level rules). */
  readonly pagesAudited: number;
  readonly thresholds: {
    readonly deepPageDepth: number;
    readonly deepPageHighDepth: number;
    readonly weakAuthorityPercentile: number;
    readonly weakAuthorityThreshold: number | null;
    readonly weakAuthorityHighThreshold: number | null;
  };
}

export interface StructuralAudit {
  readonly summary: AuditSummary;
  /** Sorted by severity, type, rule, node. */
  readonly issues: Issue[];
}

/** The page facts the robots-directive rules need (one per crawled page). */
export interface PageFacts {
  readonly fetchId: number;
  readonly url: string;
  readonly metaRobots: string | null;
  readonly metaCanonical: string | null;
  /** X-Robots-Tag response header, if any. */
  readonly xRobotsTag: string | null;
}

export interface AuditInput {
  readonly runId: number;
  readonly policyVersion: string;
  /** The policy's derived link graph (deriveGraphFromObservations). */
  readonly graph: LinkGraph;
  /** The reconciled inventory under the same policy, if discovery ran. */
  readonly reconciliation: Reconciliation | null;
  readonly pages: readonly PageFacts[];
  /** Raw URL → node under the same policy (for canonical targets). */
  readonly canonicalise: (url: string) => string;
  readonly config: Pick<
    LinkLensConfig,
    | "auditDeepPageDepth"
    | "auditDeepPageHighDepth"
    | "auditWeakAuthorityPercentile"
    | "auditWeakAuthorityHighPercentile"
  >;
}

/**
 * Percentile with linear interpolation between closest ranks (NumPy's default): p in [0, 100]
 * over the values sorted ascending; null for no values.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const h = ((xs.length - 1) * p) / 100;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = xs[lo] as number;
  return a + ((xs[hi] as number) - a) * (h - lo);
}

const tokens = (v: string | null) =>
  (v ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t !== "");
/** noindex via meta robots or X-Robots-Tag ("none" = noindex, nofollow). */
export const isNoindex = (p: Pick<PageFacts, "metaRobots" | "xRobotsTag">) =>
  [...tokens(p.metaRobots), ...tokens(p.xRobotsTag)].some((t) => t === "noindex" || t === "none");
export const isNofollow = (p: Pick<PageFacts, "metaRobots" | "xRobotsTag">) =>
  [...tokens(p.metaRobots), ...tokens(p.xRobotsTag)].some((t) => t === "nofollow" || t === "none");

const SITEMAP_CHANNELS: readonly DiscoveryChannel[] = ["xml_sitemap", "robots_sitemap"];
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Rule-based structural issues for one policy's graph:
 *  - orphan: reconciled orphan (found by a non-link channel, unreachable in the link graph), with
 *    the channels and documents that found it. High if a sitemap lists it, else medium.
 *  - deep-page: crawled page with depth > auditDeepPageDepth (high above auditDeepPageHighDepth).
 *  - weak-authority: crawled page with PageRank below the auditWeakAuthorityPercentile-th
 *    percentile of crawled pages' PageRank (high below the auditWeakAuthorityHighPercentile-th).
 *  - outside-largest-scc: reachable crawled page not in the largest SCC (low: cannot reach the
 *    site's core by links, or not reached back from it).
 *  - dead-end: crawled page with no internal out-links (medium).
 *  - noindex-nofollow-conflict, by rule:
 *      noindex-in-sitemap (high): noindex page listed in an XML or robots-declared sitemap;
 *      canonical-to-noindex (high): rel=canonical points to a different node that is noindex;
 *      nofollow-sole-path (medium): meta-nofollow page that is the only page linking to others;
 *      internal-nofollow (low): internal links with rel=nofollow point to the node.
 * Page-level robots facts come from each node's representative page. Deterministic.
 */
export function auditStructure(input: AuditInput): StructuralAudit {
  const { graph, config } = input;
  const issues: Issue[] = [];
  const add = (
    type: IssueType,
    node: string,
    severity: Severity,
    evidence: Issue["evidence"],
    rule?: ConflictRule,
  ) =>
    issues.push({
      id: rule === undefined ? `${type}:${node}` : `${type}:${rule}:${node}`,
      type,
      ...(rule === undefined ? {} : { rule }),
      node,
      severity,
      evidence,
      policyVersion: input.policyVersion,
    });

  const pageByFetch = new Map(input.pages.map((p) => [p.fetchId, p]));
  const repPage = (node: string): PageFacts | undefined => {
    const id = graph.hasNode(node) ? graph.getNodeAttribute(node, "representativeFetchId") : null;
    return id === null || id === undefined ? undefined : pageByFetch.get(id);
  };
  const crawled = graph.filterNodes((_n, a) => a.crawled);

  // --- orphan -------------------------------------------------------------------------------
  const inventory = new Map<string, InventoryEntry>(
    (input.reconciliation?.inventory ?? []).map((e) => [e.node, e]),
  );
  for (const node of input.reconciliation?.orphans ?? []) {
    const e = inventory.get(node) as InventoryEntry;
    const inSitemap = e.channels.some((c) => SITEMAP_CHANNELS.includes(c));
    add("orphan", node, inSitemap ? "high" : "medium", {
      channels: e.channels,
      sources: e.sources as { [k: string]: Json },
      inGraph: graph.hasNode(node),
    });
  }

  // --- deep-page ----------------------------------------------------------------------------
  for (const node of crawled) {
    const depth = graph.getNodeAttribute(node, "depth") ?? null;
    if (depth !== null && depth > config.auditDeepPageDepth) {
      add("deep-page", node, depth > config.auditDeepPageHighDepth ? "high" : "medium", {
        depth,
        threshold: config.auditDeepPageDepth,
      });
    }
  }

  // --- weak-authority -----------------------------------------------------------------------
  const pr = (n: string) => graph.getNodeAttribute(n, "pagerank") ?? 0;
  const prs = crawled.map(pr);
  const weakThreshold = percentile(prs, config.auditWeakAuthorityPercentile);
  const highThreshold = percentile(prs, config.auditWeakAuthorityHighPercentile);
  if (weakThreshold !== null && highThreshold !== null) {
    for (const node of crawled) {
      const value = pr(node);
      if (value < weakThreshold) {
        add("weak-authority", node, value < highThreshold ? "high" : "medium", {
          pagerank: value,
          percentile: config.auditWeakAuthorityPercentile,
          threshold: weakThreshold,
        });
      }
    }
  }

  // --- outside-largest-scc & dead-end ---------------------------------------------------------
  for (const node of crawled) {
    const a = graph.getNodeAttributes(node);
    if (a.reachable === true && a.inLargestScc !== true) {
      add("outside-largest-scc", node, "low", { sccId: a.sccId ?? null, depth: a.depth ?? null });
    }
    if ((a.outDegree ?? graph.outDegree(node)) === 0) {
      add("dead-end", node, "medium", {
        outDegree: 0,
        inDegree: a.inDegree ?? graph.inDegree(node),
      });
    }
  }

  // --- noindex / nofollow conflicts -----------------------------------------------------------
  for (const node of crawled) {
    const page = repPage(node);
    if (page === undefined) continue;
    const robots = { metaRobots: page.metaRobots, xRobotsTag: page.xRobotsTag };

    const entry = inventory.get(node);
    const sitemaps = (entry?.channels ?? []).filter((c) => SITEMAP_CHANNELS.includes(c));
    if (isNoindex(page) && sitemaps.length > 0) {
      add(
        "noindex-nofollow-conflict",
        node,
        "high",
        {
          ...robots,
          channels: sitemaps,
          sitemaps: sitemaps.flatMap((c) => entry?.sources[c] ?? []),
        },
        "noindex-in-sitemap",
      );
    }

    if (page.metaCanonical !== null) {
      let target: string | null = null;
      try {
        target = input.canonicalise(resolveReference(page.url, page.metaCanonical));
      } catch {
        target = null;
      }
      const targetPage = target !== null && target !== node ? repPage(target) : undefined;
      if (targetPage !== undefined && isNoindex(targetPage)) {
        add(
          "noindex-nofollow-conflict",
          node,
          "high",
          {
            canonical: page.metaCanonical,
            targetNode: target,
            targetMetaRobots: targetPage.metaRobots,
            targetXRobotsTag: targetPage.xRobotsTag,
          },
          "canonical-to-noindex",
        );
      }
    }

    if (isNofollow(page)) {
      const stranded = [...new Set(graph.outNeighbors(node))]
        .filter((v) => graph.inNeighbors(v).every((u) => u === node))
        .sort();
      if (stranded.length > 0) {
        add(
          "noindex-nofollow-conflict",
          node,
          "medium",
          { ...robots, strandedTargets: stranded },
          "nofollow-sole-path",
        );
      }
    }
  }

  const nofollowIn = new Map<string, Set<string>>();
  const nofollowCount = new Map<string, number>();
  graph.forEachEdge((_e, a, source, target) => {
    if (!tokens(a.rel).includes("nofollow")) return;
    nofollowCount.set(target, (nofollowCount.get(target) ?? 0) + 1);
    const s = nofollowIn.get(target) ?? new Set<string>();
    s.add(source);
    nofollowIn.set(target, s);
  });
  for (const node of [...nofollowCount.keys()].sort()) {
    add(
      "noindex-nofollow-conflict",
      node,
      "low",
      {
        nofollowLinks: nofollowCount.get(node) ?? 0,
        fromNodes: [...(nofollowIn.get(node) ?? [])].sort(),
      },
      "internal-nofollow",
    );
  }

  // --- order and summary ----------------------------------------------------------------------
  issues.sort(
    (x, y) =>
      SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
      ISSUE_TYPES.indexOf(x.type) - ISSUE_TYPES.indexOf(y.type) ||
      (x.rule ?? "").localeCompare(y.rule ?? "") ||
      (x.node < y.node ? -1 : x.node > y.node ? 1 : 0),
  );
  const count = <K extends string>(keys: readonly K[], f: (i: Issue) => K | undefined) =>
    Object.fromEntries(keys.map((k) => [k, issues.filter((i) => f(i) === k).length])) as Record<
      K,
      number
    >;

  return {
    issues,
    summary: {
      runId: input.runId,
      policyVersion: input.policyVersion,
      total: issues.length,
      byType: count(ISSUE_TYPES, (i) => i.type),
      bySeverity: count(SEVERITIES, (i) => i.severity),
      byRule: count(
        [
          "noindex-in-sitemap",
          "canonical-to-noindex",
          "nofollow-sole-path",
          "internal-nofollow",
        ] as const,
        (i) => i.rule,
      ),
      nodesWithIssues: new Set(issues.map((i) => i.node)).size,
      pagesAudited: crawled.length,
      thresholds: {
        deepPageDepth: config.auditDeepPageDepth,
        deepPageHighDepth: config.auditDeepPageHighDepth,
        weakAuthorityPercentile: config.auditWeakAuthorityPercentile,
        weakAuthorityThreshold: weakThreshold,
        weakAuthorityHighThreshold: highThreshold,
      },
    },
  };
}

export interface PersistedAudit extends StructuralAudit {
  readonly artefact: ArtefactRow;
}

/**
 * Audit a run under `policyId`: derive the policy's graph and reconciliation in memory (from the
 * run's stored config) and run the rules. Nothing is written.
 */
export async function loadAudit(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<StructuralAudit> {
  const { observations, context, config } = await loadRunGraphInputs(db, runId);
  const policy = POLICIES[policyId];
  const canonicalise = (url: string) => policy.canonicalise(url, context);
  const { graph } = deriveGraphFromObservations(observations, policyId, context, config);

  const discovered = await listDiscoveryObservations(db, runId);
  const reach = new Map<string, { reachable: boolean; depth: number | null }>();
  graph.forEachNode((n, a) =>
    reach.set(n, { reachable: a.reachable === true, depth: a.depth ?? null }),
  );
  const reconciliation =
    discovered.length === 0
      ? null
      : reconcile({
          runId,
          policyVersion: policy.version,
          observations: discovered,
          isInternal: makeInternalTest(observations.seedUrl, config.includeSubdomains),
          canonicalise,
          graph: reach,
        });

  const [pages, fetches] = await Promise.all([
    listPages(db, runId, "crawl"),
    listFetches(db, runId),
  ]);
  const xRobots = new Map(fetches.map((f) => [f.id, f.headers["x-robots-tag"] ?? null]));
  const audit = auditStructure({
    runId,
    policyVersion: policy.version,
    graph,
    reconciliation,
    pages: pages.map((p) => ({
      fetchId: p.fetchId,
      url: p.url,
      metaRobots: p.metaRobots,
      metaCanonical: p.metaCanonical,
      xRobotsTag: xRobots.get(p.fetchId) ?? null,
    })),
    canonicalise,
    config,
  });
  return audit;
}

/** loadAudit, appended as a `structural-audit` artefact (run id + policy version). */
export async function auditRun(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PersistedAudit> {
  const audit = await loadAudit(db, runId, policyId);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: audit.summary.policyVersion,
    kind: STRUCTURAL_AUDIT_ARTEFACT,
    payload: audit as unknown as Json,
  });
  return { ...audit, artefact };
}
