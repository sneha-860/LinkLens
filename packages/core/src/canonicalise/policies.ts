/**
 * Canonicalisation policies P0–P5: pure functions (url, context) → nodeId. Each policy is the
 * previous one plus one step, so each partitions URLs at least as coarsely as the one before.
 * A node id is the canonical URL string the policy produces.
 *
 * Bump a policy's version whenever its output can change for any input: every derived artefact
 * stores the version (artefacts.policy_version), and results are only comparable within one.
 */
import {
  lowerCaseOutsideEscapes,
  normalizePercentEncoding,
  parseAuthority,
  parseReference,
  recompose,
  recomposeAuthority,
  removeDotSegments,
  type Components,
} from "../url/rfc3986.js";
import type { CanonicalContext } from "./context.js";

export const POLICY_IDS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

export const P0_VERSION = "P0@1.0.0";
export const P1_VERSION = "P1@1.0.0";
export const P2_VERSION = "P2@1.0.0";
export const P3_VERSION = "P3@1.0.0";
export const P4_VERSION = "P4@1.0.0";
export const P5_VERSION = "P5@1.0.0";

export type Canonicaliser = (url: string, context: CanonicalContext) => string;

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: "80", https: "443" };
const isHttp = (scheme: string | undefined) => scheme === "http" || scheme === "https";

// ---------------------------------------------------------------------------------------------
// P0: RFC 3986 syntax-based (§6.2.2) and scheme-based (§6.2.3) normalisation
// ---------------------------------------------------------------------------------------------

function p0Components(url: string): Components {
  const c = parseReference(url);
  const scheme = c.scheme?.toLowerCase();
  let authority = c.authority;
  if (authority !== undefined) {
    const a = parseAuthority(authority);
    const port =
      a.port === "" || (scheme !== undefined && a.port === DEFAULT_PORTS[scheme])
        ? undefined
        : a.port;
    authority = recomposeAuthority({
      userinfo: a.userinfo === undefined ? undefined : normalizePercentEncoding(a.userinfo),
      host: lowerCaseOutsideEscapes(normalizePercentEncoding(a.host)),
      port,
    });
  }
  let path = removeDotSegments(normalizePercentEncoding(c.path));
  if (authority !== undefined && path === "" && isHttp(scheme)) path = "/";
  return {
    scheme,
    authority,
    path,
    query: c.query === undefined ? undefined : normalizePercentEncoding(c.query),
    fragment: c.fragment === undefined ? undefined : normalizePercentEncoding(c.fragment),
  };
}

/**
 * P0: lower-case scheme and host; normalise percent-encoding (decode unreserved, upper-case hex,
 * encode characters not allowed in URIs as UTF-8); remove dot-segments; drop the default port
 * (and an empty one); empty http(s) path → "/". Path, query and fragment case are kept.
 */
export const p0: Canonicaliser = (url) => recompose(p0Components(url));

// ---------------------------------------------------------------------------------------------
// P1: + drop fragment + unify trailing slash
// ---------------------------------------------------------------------------------------------

function p1Components(url: string): Components {
  const c = p0Components(url);
  const path = c.path.length > 1 ? c.path.replace(/\/+$/, "") || "/" : c.path;
  return { ...c, path, fragment: undefined };
}

/** P1: P0 + drop the fragment + remove trailing slashes (except the root "/"). */
export const p1: Canonicaliser = (url) => recompose(p1Components(url));

// ---------------------------------------------------------------------------------------------
// P2: + strip tracking parameters + sort remaining parameters
// ---------------------------------------------------------------------------------------------

/** Tracking parameter names (compared case-insensitively, after P0's percent normalisation). */
export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith("utm_") || n.startsWith("mc_") || n === "gclid" || n === "fbclid" || n === "ref"
  );
}

function p2Components(url: string): Components {
  const c = p1Components(url);
  if (c.query === undefined) return c;
  const params = c.query
    .split("&")
    .filter((p) => p !== "")
    .map((p, i) => ({ p, key: p.split("=", 1)[0] ?? "", i }))
    .filter(({ key }) => !isTrackingParam(key))
    // Stable sort by name only: repeated names keep their relative order (it can be meaningful).
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map(({ p }) => p);
  return { ...c, query: params.length > 0 ? params.join("&") : undefined };
}

/**
 * P2: P1 + remove tracking parameters (utm_*, mc_*, gclid, fbclid, ref) and empty parameters,
 * then sort the rest by name (stable). An empty query is dropped.
 */
export const p2: Canonicaliser = (url) => recompose(p2Components(url));

// ---------------------------------------------------------------------------------------------
// P3: + drop the query + http/https and www/non-www are one host
// ---------------------------------------------------------------------------------------------

function p3Components(url: string): Components {
  const c = p2Components(url);
  if (!isHttp(c.scheme) || c.authority === undefined) return { ...c, query: undefined };
  const a = parseAuthority(c.authority);
  const bare = a.host.startsWith("www.") ? a.host.slice(4) : a.host;
  const host = bare.includes(".") ? bare : a.host; // keep "www.com"-style hosts intact
  return { ...c, scheme: "https", authority: recomposeAuthority({ ...a, host }), query: undefined };
}

/**
 * P3: P2 + drop the whole query string + treat http/https and www./bare host as the same host
 * (node form: https, no leading "www."). Explicit non-default ports are kept.
 */
export const p3: Canonicaliser = (url) => recompose(p3Components(url));

// ---------------------------------------------------------------------------------------------
// P4: + follow recorded redirects
// ---------------------------------------------------------------------------------------------

/**
 * P4: P3, then follow the recorded redirect edges to the final node. A redirect loop maps every
 * node on the loop to the loop's smallest node, so the result does not depend on the start.
 */
export const p4: Canonicaliser = (url, ctx) => {
  let node = p3(url, ctx);
  const seen: string[] = [];
  for (;;) {
    const next = ctx.redirects.get(node);
    if (next === undefined) return node;
    seen.push(node);
    const loopStart = seen.indexOf(next);
    if (loopStart !== -1) {
      return seen.slice(loopStart).reduce((min, n) => (n < min ? n : min));
    }
    node = next;
  }
};

// ---------------------------------------------------------------------------------------------
// P5: + follow the publisher's rel=canonical (RFC 6596), guarded
// ---------------------------------------------------------------------------------------------

/** Same site under P3's host equivalence (scheme and www. already unified in node ids). */
export function sameSite(a: string, b: string): boolean {
  const x = parseReference(a);
  const y = parseReference(b);
  return x.scheme === y.scheme && x.authority !== undefined && x.authority === y.authority;
}

/**
 * P5: P4, then follow rel=canonical hop by hop while each hop is valid:
 *  - the target is on the same site (P3 host equivalence) and not the page itself;
 *  - the target was fetched successfully (2xx), per the recorded fetches.
 * An invalid hop stops the walk at the current node. Guards:
 *  - cycle: the walk stops at the node where the cycle starts (nodes on a canonical cycle keep
 *    themselves; pages pointing into a cycle map to its entry node);
 *  - chain longer than context.maxCanonicalHops: not trusted, the page keeps its P4 node.
 */
export const p5: Canonicaliser = (url, ctx) => {
  const start = p4(url, ctx);
  const path = [start];
  let node = start;
  for (;;) {
    const target = ctx.canonicals.get(node);
    if (target === undefined || target === node) return node;
    if (!sameSite(node, target) || !ctx.fetchedOk.has(target)) return node;
    if (path.includes(target)) return target;
    if (path.length > ctx.maxCanonicalHops) return start;
    path.push(target);
    node = target;
  }
};

// ---------------------------------------------------------------------------------------------

export interface Policy {
  readonly id: PolicyId;
  readonly version: string;
  readonly canonicalise: Canonicaliser;
}

export const POLICIES: Readonly<Record<PolicyId, Policy>> = Object.freeze({
  P0: { id: "P0", version: P0_VERSION, canonicalise: p0 },
  P1: { id: "P1", version: P1_VERSION, canonicalise: p1 },
  P2: { id: "P2", version: P2_VERSION, canonicalise: p2 },
  P3: { id: "P3", version: P3_VERSION, canonicalise: p3 },
  P4: { id: "P4", version: P4_VERSION, canonicalise: p4 },
  P5: { id: "P5", version: P5_VERSION, canonicalise: p5 },
});
