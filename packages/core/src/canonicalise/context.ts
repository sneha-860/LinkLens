/**
 * What P4 and P5 know beyond the URL itself. Keys and values are policy nodes, not raw URLs:
 * build it with `buildCanonicalContext` so they are always computed by the current policies.
 */
export interface CanonicalContext {
  /** P3 node → P3 node it redirects to (one chosen edge per source; self-edges removed). */
  readonly redirects: ReadonlyMap<string, string>;
  /** P4 node of a page → P4 node of its declared rel=canonical (unvalidated; P5 validates). */
  readonly canonicals: ReadonlyMap<string, string>;
  /** P4 nodes that were fetched successfully (a 2xx final response). */
  readonly fetchedOk: ReadonlySet<string>;
  /** Max rel=canonical hops P5 follows (config.canonicalMaxHops). */
  readonly maxCanonicalHops: number;
}

/** A context with no observations: P4 = P3 and P5 = P4. */
export const EMPTY_CONTEXT: CanonicalContext = Object.freeze({
  redirects: new Map<string, string>(),
  canonicals: new Map<string, string>(),
  fetchedOk: new Set<string>(),
  maxCanonicalHops: 0,
});
