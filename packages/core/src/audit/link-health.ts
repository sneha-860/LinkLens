import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import type { LinkLensConfig } from "../config.js";
import { listFinalFetches, listLinkObservations, listPages } from "../db/queries.js";
import type { FetchRow, LinkObservationRow, PageRow, Queryable, RedirectHop } from "../db/types.js";
import { loadRunGraphInputs } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import { stripFragment } from "../url/rfc3986.js";

/** Bump whenever the report can change. */
export const LINK_HEALTH_VERSION = "link-health@1.0.0";

/**
 * Broken internal links and redirect chains, from what the crawl already recorded (no request
 * is made). A link u → t is joined to the crawl fetch of t by the exact string the crawler
 * requested: `resolved_url` without its fragment (`stripFragment`), as the frontier keys it.
 * The fetch's final attempt (`final_fetches`, so retried 5xx count once) gives the outcome:
 *
 * - broken: the final status is 4xx or 5xx, whether answered directly or at the end of redirects;
 * - redirect chain: at least `linkHealthMinChainHops` redirect hops (each 3xx response is a hop,
 *   `redirect_chain`), with the chain, its final URL and status, or why it stopped (too many
 *   redirects, off-site or unparsable Location);
 * - not judged, only counted: links whose target was never fetched (not admitted: page cap,
 *   nofollow, unparsable) and fetches without a status (robots.txt block, network error,
 *   timeout).
 *
 * Only crawled pages' links count (rescue and discovery pages store no links); external and
 * non-http links are left out by the crawler's scope rule.
 */

export interface LinkSource {
  /** The source page as fetched (its URL) and its node under the policy. */
  readonly page: string;
  readonly node: string;
  /** Link observations from this page to the target. */
  readonly links: number;
  /** Distinct anchor texts and DOM regions, in document order. */
  readonly anchors: string[];
  readonly regions: string[];
}

interface TargetBase {
  /** The URL linked to, as requested (resolved, fragment dropped). */
  readonly url: string;
  readonly node: string;
  readonly finalUrl: string | null;
  readonly finalStatus: number | null;
  readonly chain: RedirectHop[];
  readonly error: string | null;
  readonly links: number;
  readonly sources: LinkSource[];
}

export interface BrokenTarget extends TargetBase {
  readonly class: "4xx" | "5xx";
  /** Redirect hops before the error (0 when it answered with the error directly). */
  readonly hops: number;
}

export interface RedirectChain extends TargetBase {
  readonly hops: number;
  /** The chain ended on an error or did not end (too many redirects, off-site, bad Location). */
  readonly endsBroken: boolean;
}

export interface LinkHealthSummary {
  /** Internal link observations on crawled pages, and those whose target was fetched. */
  readonly internalLinks: number;
  readonly checkedLinks: number;
  /** Target never fetched (not admitted: page cap, nofollow, unparsable). */
  readonly uncheckedLinks: number;
  /** Target fetched without a status (robots.txt block, network error, timeout). */
  readonly failedLinks: number;
  readonly brokenTargets: number;
  readonly brokenLinks: number;
  readonly brokenSourcePages: number;
  /** Broken targets per final status code. */
  readonly statuses: Record<string, number>;
  /** Targets reached through any redirect, and those with a chain (≥ minChainHops hops). */
  readonly redirectTargets: number;
  readonly chainTargets: number;
  readonly chainLinks: number;
  readonly maxHops: number;
  readonly minChainHops: number;
}

export interface LinkHealth {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly summary: LinkHealthSummary;
  /** Most links first, then URL. */
  readonly broken: BrokenTarget[];
  /** Longest chains first, then most links, then URL. */
  readonly redirectChains: RedirectChain[];
}

export interface LinkHealthInput {
  readonly runId: number;
  readonly policyVersion: string;
  readonly pages: readonly Pick<PageRow, "fetchId" | "url">[];
  readonly links: readonly Pick<
    LinkObservationRow,
    "sourceFetchId" | "resolvedUrl" | "anchorText" | "domRegion" | "positionIndex" | "id"
  >[];
  /** Final attempt per requested URL (crawl purpose only is used). */
  readonly fetches: readonly Pick<
    FetchRow,
    "requestedUrl" | "finalUrl" | "statusCode" | "redirectChain" | "error" | "purpose"
  >[];
  readonly isInternal: (url: string) => boolean;
  readonly node: (url: string) => string;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the link-health report of one run. */
export function linkHealth(
  input: LinkHealthInput,
  config: Pick<LinkLensConfig, "linkHealthMinChainHops">,
): LinkHealth {
  const pageOf = new Map(input.pages.map((p) => [p.fetchId, p]));
  const fetchOf = new Map<string, LinkHealthInput["fetches"][number]>();
  for (const f of input.fetches) if (f.purpose === "crawl") fetchOf.set(f.requestedUrl, f);
  const safeNode = (url: string) => {
    try {
      return input.node(url);
    } catch {
      return url;
    }
  };

  // Every internal link on a crawled page, grouped by target and then by source page.
  type Acc = { page: string; links: number; anchors: string[]; regions: string[]; first: number };
  const byTarget = new Map<string, Map<string, Acc>>();
  let internalLinks = 0;
  let uncheckedLinks = 0;
  let failedLinks = 0;
  const ordered = [...input.links].sort(
    (a, b) => a.sourceFetchId - b.sourceFetchId || a.positionIndex - b.positionIndex || a.id - b.id,
  );
  for (const l of ordered) {
    const page = pageOf.get(l.sourceFetchId);
    if (page === undefined || l.resolvedUrl === null) continue;
    const target = stripFragment(l.resolvedUrl);
    if (!URL.canParse(target) || !input.isInternal(target)) continue;
    internalLinks += 1;
    const f = fetchOf.get(target);
    if (f === undefined) {
      uncheckedLinks += 1;
      continue;
    }
    if (f.statusCode === null) {
      failedLinks += 1;
      continue;
    }
    let sources = byTarget.get(target);
    if (sources === undefined) byTarget.set(target, (sources = new Map()));
    let acc = sources.get(page.url);
    if (acc === undefined) {
      sources.set(
        page.url,
        (acc = { page: page.url, links: 0, anchors: [], regions: [], first: l.id }),
      );
    }
    acc.links += 1;
    const anchor = (l.anchorText ?? "").trim();
    if (anchor !== "" && !acc.anchors.includes(anchor)) acc.anchors.push(anchor);
    const region = l.domRegion ?? "body";
    if (!acc.regions.includes(region)) acc.regions.push(region);
  }

  const broken: BrokenTarget[] = [];
  const chains: RedirectChain[] = [];
  let checkedLinks = 0;
  let redirectTargets = 0;
  const statuses: Record<string, number> = {};
  for (const [url, sourceMap] of [...byTarget].sort(([a], [b]) => byText(a, b))) {
    const f = fetchOf.get(url) as LinkHealthInput["fetches"][number];
    const sources = [...sourceMap.values()]
      .sort((a, b) => byText(a.page, b.page))
      .map(({ page, links, anchors, regions }) => ({
        page,
        node: safeNode(page),
        links,
        anchors,
        regions,
      }));
    const links = sources.reduce((n, s) => n + s.links, 0);
    checkedLinks += links;
    const status = f.statusCode as number;
    const hops = f.redirectChain.length;
    // A chain whose last response is still a redirect never reached a page (no Location, too
    // many redirects, off-site or unparsable Location, or a hop blocked by robots.txt).
    const unfinished = status >= 300 && status < 400;
    const base = {
      url,
      node: safeNode(url),
      finalUrl: f.finalUrl,
      finalStatus: status,
      chain: [...f.redirectChain],
      error: f.error,
      links,
      sources,
    };
    if (status >= 400) {
      broken.push({ ...base, class: status >= 500 ? "5xx" : "4xx", hops });
      statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
    }
    if (hops > 0) redirectTargets += 1;
    if (hops >= config.linkHealthMinChainHops) {
      chains.push({ ...base, hops, endsBroken: status >= 400 || unfinished });
    }
  }
  broken.sort((a, b) => b.links - a.links || byText(a.url, b.url));
  chains.sort((a, b) => b.hops - a.hops || b.links - a.links || byText(a.url, b.url));

  return {
    version: LINK_HEALTH_VERSION,
    runId: input.runId,
    policyVersion: input.policyVersion,
    summary: {
      internalLinks,
      checkedLinks,
      uncheckedLinks,
      failedLinks,
      brokenTargets: broken.length,
      brokenLinks: broken.reduce((n, t) => n + t.links, 0),
      brokenSourcePages: new Set(broken.flatMap((t) => t.sources.map((s) => s.page))).size,
      statuses: Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => byText(a, b))),
      redirectTargets,
      chainTargets: chains.length,
      chainLinks: chains.reduce((n, t) => n + t.links, 0),
      maxHops: chains.reduce((m, t) => Math.max(m, t.hops), 0),
      minChainHops: config.linkHealthMinChainHops,
    },
    broken,
    redirectChains: chains,
  };
}

/** The run's link-health report, with nodes under `policyId` (computed, nothing is written). */
export async function loadLinkHealth(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<LinkHealth> {
  const [{ observations, context, config }, pages, links, fetches] = await Promise.all([
    loadRunGraphInputs(db, runId),
    listPages(db, runId, "crawl"),
    listLinkObservations(db, runId),
    listFinalFetches(db, runId),
  ]);
  const policy = POLICIES[policyId];
  return linkHealth(
    {
      runId,
      policyVersion: policy.version,
      pages,
      links,
      fetches,
      isInternal: makeInternalTest(observations.seedUrl, config.includeSubdomains),
      node: (url) => policy.canonicalise(url, context),
    },
    config,
  );
}
