import { resolveReference } from "../url/rfc3986.js";
import type { CanonicalContext } from "./context.js";
import { p3, p4 } from "./policies.js";

export interface CanonicalObservations {
  /** Observed redirects: absolute source URL → absolute target URL (raw strings). */
  readonly redirects?: Iterable<readonly [from: string, to: string]>;
  /** Pages and their rel=canonical href as written (resolved here against the page URL). */
  readonly canonicals?: Iterable<readonly [pageUrl: string, href: string]>;
  /** Absolute URLs whose fetch ended in a 2xx response. */
  readonly fetchedOk?: Iterable<string>;
}

/**
 * Pick one target per source: the most often observed; ties go to the smallest string, so the
 * result never depends on observation order (determinism).
 */
function chooseEdges(edges: Iterable<readonly [string, string]>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const [from, to] of edges) {
    if (from === to) continue;
    const byTarget = counts.get(from) ?? new Map<string, number>();
    byTarget.set(to, (byTarget.get(to) ?? 0) + 1);
    counts.set(from, byTarget);
  }
  const chosen = new Map<string, string>();
  // Insert in sorted order so iterating the context is deterministic too.
  for (const [from, byTarget] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let best: [string, number] | null = null;
    for (const [to, n] of byTarget) {
      if (best === null || n > best[1] || (n === best[1] && to < best[0])) best = [to, n];
    }
    if (best !== null) chosen.set(from, best[0]);
  }
  return chosen;
}

function* mapEdges(
  pairs: Iterable<readonly [string, string]> | undefined,
  f: (from: string, to: string) => readonly [string, string] | null,
): Iterable<readonly [string, string]> {
  for (const [from, to] of pairs ?? []) {
    const edge = f(from, to);
    if (edge !== null) yield edge;
  }
}

/**
 * Build the P4/P5 context from raw observations. Redirect edges are projected onto P3 nodes and
 * canonical edges onto P4 nodes (so a canonical pointing at a redirecting URL lands on the
 * redirect's target); fetchedOk holds P4 nodes. Invalid references are skipped.
 */
export function buildCanonicalContext(
  obs: CanonicalObservations,
  options: { readonly maxCanonicalHops: number },
): CanonicalContext {
  const empty: CanonicalContext = {
    redirects: new Map(),
    canonicals: new Map(),
    fetchedOk: new Set(),
    maxCanonicalHops: options.maxCanonicalHops,
  };
  const redirects = chooseEdges(
    mapEdges(obs.redirects, (from, to) => [p3(from, empty), p3(to, empty)]),
  );
  const withRedirects: CanonicalContext = { ...empty, redirects };

  const fetchedOk = new Set<string>();
  for (const url of obs.fetchedOk ?? []) fetchedOk.add(p4(url, withRedirects));

  const canonicals = chooseEdges(
    mapEdges(obs.canonicals, (page, href) => {
      let target: string;
      try {
        target = resolveReference(page, href);
      } catch {
        return null; // page URL not absolute
      }
      return [p4(page, withRedirects), p4(target, withRedirects)];
    }),
  );
  return { ...withRedirects, canonicals, fetchedOk };
}

/** The fields of a fetches row this needs (FetchRow satisfies it). */
export interface FetchFacts {
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly statusCode: number | null;
  readonly redirectChain: readonly { url: string; statusCode?: number; location?: string | null }[];
}

/** The fields of a pages row this needs (PageRow satisfies it). */
export interface PageFacts {
  readonly url: string;
  readonly metaCanonical: string | null;
}

/**
 * Observations straight from stored rows: every redirect hop with a Location becomes an edge
 * (Location resolved against the hop URL); fetches whose final status is 2xx count as fetched
 * successfully (both the requested and the final URL); every page with a canonical tag
 * contributes its declaration. Pass the run's final fetches (listFinalFetches) or all attempts.
 */
export function observationsFromRows(
  fetches: readonly FetchFacts[],
  pages: readonly PageFacts[],
): CanonicalObservations {
  const redirects: [string, string][] = [];
  const fetchedOk: string[] = [];
  for (const f of fetches) {
    for (const hop of f.redirectChain) {
      if (hop.location === undefined || hop.location === null) continue;
      try {
        redirects.push([hop.url, resolveReference(hop.url, hop.location)]);
      } catch {
        // hop URL not absolute: skip
      }
    }
    if (f.statusCode !== null && f.statusCode >= 200 && f.statusCode < 300) {
      fetchedOk.push(f.requestedUrl);
      if (f.finalUrl !== null) fetchedOk.push(f.finalUrl);
    }
  }
  const canonicals = pages
    .filter((p) => p.metaCanonical !== null)
    .map((p) => [p.url, p.metaCanonical as string] as const);
  return { redirects, canonicals, fetchedOk };
}
