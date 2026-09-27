import { createHash } from "node:crypto";
import { canonicalise, db as q, graph, stats, type SigmaVariant } from "@linklens/core";
import {
  auditInMemory,
  loadRunInputs,
  p3Of,
  type AuditOutcome,
  type RunInputs,
} from "./in-memory.js";

type PolicyId = canonicalise.PolicyId;

/**
 * E4: two crawls of the same site (14 days apart), compared in P3 form, with their differences
 * split between the site and the method.
 *
 * Every page crawled in either run is classified:
 * - both runs crawled it: `unchanged` (same content signature: title, h1, body, meta robots,
 *   canonical, and every outgoing link with its anchor and region, in order) or `changed`;
 * - one run only: the other run's own record says why. Site change: it answered 4xx (`gone`),
 *   redirected elsewhere (`redirect`), was not HTML (`not-html`), was blocked by robots.txt or
 *   its Crawl-delay (`robots`), or no crawled page linked to it (`link`: the link was added or
 *   removed). Method (crawl) instability: a page linked to it but it was not admitted (the page
 *   cap or crawl order: `not-admitted`), or its fetch failed (5xx, network, timeout, robots.txt
 *   unreachable: `failed`).
 *
 * Four comparisons of the audit (node overlap, PageRank Spearman, orphan Jaccard, top-k fixes):
 * - `observed`: the two runs as crawled;
 * - `siteChange`: each run restricted to the pages both crawled plus its site-caused ones. The
 *   crawl's coverage noise is gone: what differs is the site;
 * - `samePages`: both restricted to the unchanged pages and the unchanged discovery documents.
 *   The inputs are identical, so any difference is the method's own instability;
 * - `coverageA` / `coverageB`: each run against itself without the pages the other run missed
 *   for method reasons: how much the crawl's coverage noise moves the results.
 */
export const SITE_REASONS = ["gone", "redirect", "not-html", "robots", "link"] as const;
export const METHOD_REASONS = ["not-admitted", "failed"] as const;
export type SiteReason = (typeof SITE_REASONS)[number];
export type MethodReason = (typeof METHOD_REASONS)[number];

export interface PageClass {
  readonly node: string;
  readonly status: "unchanged" | "changed" | "onlyA" | "onlyB";
  readonly cause: "site" | "method" | null;
  readonly reason: SiteReason | MethodReason | null;
}

export interface Comparison {
  readonly crawledA: number;
  readonly crawledB: number;
  /** Jaccard of the crawled page sets. */
  readonly nodeJaccard: number;
  /** Spearman of PageRank over the pages in both graphs (null: < 2 or no variation). */
  readonly pagerankSpearman: number | null;
  readonly sharedNodes: number;
  readonly orphansA: number;
  readonly orphansB: number;
  readonly orphanJaccard: number;
  readonly topFixesJaccard: number;
  readonly fixesA: number;
  readonly fixesB: number;
}

export const COMPARISONS = [
  "observed",
  "siteChange",
  "samePages",
  "coverageA",
  "coverageB",
] as const;
export type ComparisonName = (typeof COMPARISONS)[number];

export interface Stability {
  readonly runA: number;
  readonly runB: number;
  readonly daysApart: number;
  readonly policyVersion: string;
  readonly k: number;
  readonly pages: {
    readonly union: number;
    readonly unchanged: number;
    readonly changed: number;
    /** One run only, by cause and reason (onlyA and onlyB together). */
    readonly site: Record<SiteReason, number>;
    readonly method: Record<MethodReason, number>;
    readonly onlyA: number;
    readonly onlyB: number;
  };
  /** Pages changed or site-caused, of the union; and crawl-caused, of the union. */
  readonly siteChangeShare: number;
  readonly methodShare: number;
  /** Discovery documents (channel + document) by whether their listed URLs changed. */
  readonly discoveryDocuments: {
    readonly unchanged: number;
    readonly changed: number;
    readonly onlyA: number;
    readonly onlyB: number;
  };
  readonly comparisons: Record<ComparisonName, Comparison>;
  /** Every page's class (sorted by node). */
  readonly classes: PageClass[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Pure: each crawled page's content signature, by P3 node (the earliest-fetched page). */
export function pageSignatures(inputs: RunInputs): Map<string, string> {
  const p3 = p3Of(inputs);
  const isInternal = graph.makeInternalTest(
    inputs.observations.seedUrl,
    inputs.config.includeSubdomains,
  );
  const target = (url: string | null) => {
    if (url === null) return null;
    try {
      return isInternal(url) ? p3(url) : `external:${url}`;
    } catch {
      return `raw:${url}`;
    }
  };
  const rows = new Map<number, q.LinkObservationRow[]>();
  for (const r of inputs.linkRows)
    rows.set(r.sourceFetchId, [...(rows.get(r.sourceFetchId) ?? []), r]);
  const out = new Map<string, string>();
  for (const p of [...inputs.pages].sort((a, b) => a.fetchId - b.fetchId)) {
    const node = p3(p.url);
    if (out.has(node)) continue;
    const links = [...(rows.get(p.fetchId) ?? [])]
      .sort((a, b) => a.positionIndex - b.positionIndex)
      .map((l) => [target(l.resolvedUrl), l.anchorText, l.domRegion, l.rel]);
    out.set(
      node,
      sha(
        JSON.stringify([
          p.title,
          p.h1,
          p.bodyText,
          p.metaRobots,
          p.metaCanonical === null ? null : target(p.metaCanonical),
          p.nofollow,
          links,
        ]),
      ),
    );
  }
  return out;
}

/** Pure: the P3 pages a run's crawled pages link to. */
function linkedTargets(inputs: RunInputs): Set<string> {
  const p3 = p3Of(inputs);
  const isInternal = graph.makeInternalTest(
    inputs.observations.seedUrl,
    inputs.config.includeSubdomains,
  );
  const out = new Set<string>();
  for (const l of inputs.linkRows) {
    if (l.resolvedUrl === null || !isInternal(l.resolvedUrl)) continue;
    try {
      out.add(p3(l.resolvedUrl));
    } catch {
      // unparsable: never fetched either
    }
  }
  return out;
}

/** Why `other` has no crawled page for `node`, from its own fetches and links. */
function whyMissing(
  node: string,
  other: RunInputs,
): { cause: "site" | "method"; reason: SiteReason | MethodReason } {
  const p3 = p3Of(other);
  const latest = new Map<string, q.FetchRow>();
  for (const f of other.fetches) {
    const prev = latest.get(f.requestedUrl);
    if (
      prev === undefined ||
      f.attempt > prev.attempt ||
      (f.attempt === prev.attempt && f.id > prev.id)
    ) {
      latest.set(f.requestedUrl, f);
    }
  }
  const tries = [...latest.values()].filter((f) => {
    try {
      return p3(f.requestedUrl) === node;
    } catch {
      return false;
    }
  });
  const site = (reason: SiteReason) => ({ cause: "site" as const, reason });
  const method = (reason: MethodReason) => ({ cause: "method" as const, reason });
  if (tries.length > 0) {
    // The most telling outcome among the URLs that map to the node.
    for (const f of tries)
      if (f.statusCode !== null && f.statusCode >= 400 && f.statusCode < 500) return site("gone");
    for (const f of tries) {
      if (f.finalUrl !== null && f.finalUrl !== f.requestedUrl) {
        try {
          if (p3(f.finalUrl) !== node) return site("redirect");
        } catch {
          return site("redirect");
        }
      }
    }
    for (const f of tries) {
      if (f.statusCode !== null && f.statusCode >= 200 && f.statusCode < 300)
        return site("not-html");
    }
    for (const f of tries) {
      const e = f.error ?? "";
      if (/unreachable/i.test(e)) return method("failed");
      if (/blocked by robots\.txt|Crawl-delay/i.test(e)) return site("robots");
    }
    return method("failed");
  }
  return linkedTargets(other).has(node) ? method("not-admitted") : site("link");
}

/** Pure: classify every page crawled in either run. */
export function classifyPages(a: RunInputs, b: RunInputs): PageClass[] {
  const sa = pageSignatures(a);
  const sb = pageSignatures(b);
  const nodes = [...new Set([...sa.keys(), ...sb.keys()])].sort();
  return nodes.map((node): PageClass => {
    const x = sa.get(node);
    const y = sb.get(node);
    if (x !== undefined && y !== undefined) {
      return {
        node,
        status: x === y ? "unchanged" : "changed",
        cause: x === y ? null : "site",
        reason: null,
      };
    }
    const why = whyMissing(node, x === undefined ? a : b);
    return { node, status: x === undefined ? "onlyB" : "onlyA", ...why };
  });
}

/** Pure: each discovery document (channel + source) and the sorted URLs it listed (P3). */
export function discoveryDocuments(inputs: RunInputs): Map<string, string> {
  const p3 = p3Of(inputs);
  const docs = new Map<string, Set<string>>();
  for (const o of inputs.discovery) {
    if (o.channel === "link_graph") continue; // follows the pages
    const key = JSON.stringify([o.channel, o.sourceDocument]);
    const set = docs.get(key) ?? new Set<string>();
    let url = o.url;
    try {
      url = p3(o.url);
    } catch {
      // keep raw
    }
    set.add(`${o.detail["kind"] === "directive" ? "directive:" : ""}${url}`);
    docs.set(key, set);
  }
  return new Map([...docs].map(([k, v]) => [k, JSON.stringify([...v].sort())]));
}

/** Pure: two audit outcomes compared. */
export function compareOutcomes(a: AuditOutcome, b: AuditOutcome): Comparison {
  let shared = 0;
  for (const k of a.pagerank.keys()) if (b.pagerank.has(k)) shared += 1;
  return {
    crawledA: a.crawled.size,
    crawledB: b.crawled.size,
    nodeJaccard: stats.jaccard(a.crawled, b.crawled),
    pagerankSpearman: stats.spearman(a.pagerank, b.pagerank),
    sharedNodes: shared,
    orphansA: a.orphans.size,
    orphansB: b.orphans.size,
    orphanJaccard: stats.jaccard(a.orphans, b.orphans),
    topFixesJaccard: stats.jaccard(a.topFixes, b.topFixes),
    fixesA: a.fixes,
    fixesB: b.fixes,
  };
}

const count = <T extends string>(keys: readonly T[], xs: readonly (T | null)[]) =>
  Object.fromEntries(keys.map((k) => [k, xs.filter((x) => x === k).length])) as Record<T, number>;

/** Pure (E4): compare two runs of one site, separating site change from method instability. */
export function compareRuns(
  a: RunInputs,
  b: RunInputs,
  options: { readonly policyId: PolicyId; readonly k: number; readonly sigma?: SigmaVariant },
): Stability {
  const classes = classifyPages(a, b);
  const nodes = (f: (c: PageClass) => boolean) => new Set(classes.filter(f).map((c) => c.node));
  const both = nodes((c) => c.status === "unchanged" || c.status === "changed");
  const unchanged = nodes((c) => c.status === "unchanged");
  const siteA = nodes((c) => c.status === "onlyA" && c.cause === "site");
  const siteB = nodes((c) => c.status === "onlyB" && c.cause === "site");
  const methodA = nodes((c) => c.status === "onlyA" && c.cause === "method");
  const methodB = nodes((c) => c.status === "onlyB" && c.cause === "method");
  const union = classes.length;

  // Discovery documents: the same channel + document listing the same URLs.
  const da = discoveryDocuments(a);
  const db = discoveryDocuments(b);
  const sameDocs = new Set([...da].filter(([k, v]) => db.get(k) === v).map(([k]) => k));
  const docKey = (o: q.DiscoveryObservationRow) => JSON.stringify([o.channel, o.sourceDocument]);
  const unchangedDiscovery = (run: RunInputs) => {
    const p3 = p3Of(run);
    return (o: q.DiscoveryObservationRow) => {
      if (o.channel !== "link_graph") return sameDocs.has(docKey(o));
      if (o.sourceDocument === null) return true; // the seed
      try {
        return unchanged.has(p3(o.sourceDocument));
      } catch {
        return false;
      }
    };
  };

  const run = (inputs: RunInputs, extra: Partial<Parameters<typeof auditInMemory>[1]> = {}) =>
    auditInMemory(inputs, {
      policyId: options.policyId,
      k: options.k,
      ...(options.sigma === undefined ? {} : { sigma: options.sigma }),
      ...extra,
    });
  const fullA = run(a);
  const fullB = run(b);
  const scopeA = new Set([...both, ...siteA]);
  const scopeB = new Set([...both, ...siteB]);
  const siteOnlyA = methodA.size === 0 ? fullA : run(a, { pages: scopeA });
  const siteOnlyB = methodB.size === 0 ? fullB : run(b, { pages: scopeB });

  return {
    runA: a.runId,
    runB: b.runId,
    daysApart: Math.abs(b.startedAt.getTime() - a.startedAt.getTime()) / 86_400_000,
    policyVersion: canonicalise.POLICIES[options.policyId].version,
    k: options.k,
    pages: {
      union,
      unchanged: unchanged.size,
      changed: both.size - unchanged.size,
      site: count(
        SITE_REASONS,
        classes.filter((c) => c.cause === "site").map((c) => c.reason as SiteReason),
      ),
      method: count(
        METHOD_REASONS,
        classes.filter((c) => c.cause === "method").map((c) => c.reason as MethodReason),
      ),
      onlyA: siteA.size + methodA.size,
      onlyB: siteB.size + methodB.size,
    },
    siteChangeShare: union === 0 ? 0 : classes.filter((c) => c.cause === "site").length / union,
    methodShare: union === 0 ? 0 : classes.filter((c) => c.cause === "method").length / union,
    discoveryDocuments: {
      unchanged: sameDocs.size,
      changed: [...da.keys()].filter((k) => db.has(k) && !sameDocs.has(k)).length,
      onlyA: [...da.keys()].filter((k) => !db.has(k)).length,
      onlyB: [...db.keys()].filter((k) => !da.has(k)).length,
    },
    comparisons: {
      observed: compareOutcomes(fullA, fullB),
      siteChange: compareOutcomes(siteOnlyA, siteOnlyB),
      samePages: compareOutcomes(
        run(a, { pages: unchanged, discovery: unchangedDiscovery(a) }),
        run(b, { pages: unchanged, discovery: unchangedDiscovery(b) }),
      ),
      coverageA: compareOutcomes(fullA, siteOnlyA),
      coverageB: compareOutcomes(siteOnlyB, fullB),
    },
    classes,
  };
}

/** E4 for two stored runs of the same site. */
export async function compareStoredRuns(
  db: q.Queryable,
  runA: number,
  runB: number,
  options: { readonly policyId: PolicyId; readonly k?: number; readonly sigma?: SigmaVariant },
): Promise<Stability> {
  const [a, b] = await Promise.all([
    loadRunInputs(db, runA, options.policyId),
    loadRunInputs(db, runB, options.policyId),
  ]);
  if (a.observations.seedUrl !== b.observations.seedUrl) {
    throw new Error(`runs ${runA} and ${runB} crawl different seeds`);
  }
  return compareRuns(a, b, {
    policyId: options.policyId,
    k: options.k ?? a.config.fixTopK,
    ...(options.sigma === undefined ? {} : { sigma: options.sigma }),
  });
}
