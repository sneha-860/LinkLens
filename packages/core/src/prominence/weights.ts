import { PROMINENCE_REGIONS, type LinkLensConfig, type ProminenceRegion } from "../config.js";

/** Bump whenever the output can change (factors, their combination, analytics override). */
export const PROMINENCE_VERSION = "prominence@1.0.0";

type ProminenceConfig = Pick<
  LinkLensConfig,
  | "prominenceRegionWeights"
  | "prominencePositionDecay"
  | "prominenceSitewideShare"
  | "prominenceSitewideDiscount"
>;

/** The region class of a stored dom_region: main, body and a missing region count as body. */
export function regionClass(domRegion: string | null): ProminenceRegion {
  if (domRegion === null || domRegion === "main") return "body";
  return (PROMINENCE_REGIONS as readonly string[]).includes(domRegion)
    ? (domRegion as ProminenceRegion)
    : "body";
}

/** One link observation on a node's representative page. */
export interface PageLink {
  readonly observationId: number;
  readonly domRegion: string | null;
  readonly templateSignature: string | null;
  readonly positionIndex: number;
  /**
   * The node this link is an edge to in the policy's graph, or null when it is not an edge
   * (external, non-http, self-loop). Such links still take a body rank and mark their template.
   */
  readonly target: string | null;
}

/** A node's representative page and every link observation on it. */
export interface PageLinks {
  readonly node: string;
  readonly links: readonly PageLink[];
}

/** Analytics clicks already mapped to policy nodes (null = could not be mapped). */
export interface NodeClicks {
  readonly source: string | null;
  readonly target: string | null;
  readonly clicks: number;
  /** Why the row could not be used, set by the caller when source/target is null. */
  readonly reason?: "invalid-url" | "external";
}

export interface ProminenceEdge {
  readonly source: string;
  readonly target: string;
  /** W(u,v): the structural proxy, or the analytics clicks when the source is overridden. */
  readonly weight: number;
  /** ω(u,v) = W(u,v) / Σ_v W(u,v) (0 when the source's total is 0). */
  readonly omega: number;
  readonly origin: "structural" | "analytics";
  /** The structural W(u,v), kept even when analytics override it. */
  readonly structuralWeight: number;
  /** Clicks for this edge (only when the source is overridden). */
  readonly clicks: number | null;
  /** Link observations u→v, and how many sit in each region class. */
  readonly observations: number;
  readonly regions: Partial<Record<ProminenceRegion, number>>;
}

/** The three factors of one observation (exported for explanations and tests). */
export interface ObservationFactors {
  readonly observationId: number;
  readonly region: ProminenceRegion;
  readonly regionWeight: number;
  /** Rank among the page's body links (0 = first), or null outside the body. */
  readonly bodyRank: number | null;
  readonly positionFactor: number;
  readonly sitewide: boolean;
  readonly sitewideDiscount: number;
  /** regionWeight × positionFactor × sitewideDiscount. */
  readonly weight: number;
}

export interface SitewideTemplate {
  readonly signature: string;
  readonly pages: number;
  readonly share: number;
}

export interface Prominence {
  readonly version: string;
  readonly params: ProminenceConfig;
  readonly stats: {
    readonly pages: number;
    readonly edges: number;
    /** Observations that are graph edges. */
    readonly observations: number;
    readonly sitewideTemplates: SitewideTemplate[];
    readonly analytics: {
      readonly rows: number;
      readonly matchedRows: number;
      readonly unmatched: {
        readonly invalidUrl: number;
        readonly external: number;
        readonly selfLoop: number;
        readonly noLink: number;
      };
      readonly overriddenSources: number;
    } | null;
  };
  /** Sorted by source, then target. */
  readonly edges: ProminenceEdge[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The factors of every observation: its region's weight; for body links, the reasonable-surfer
 * position factor 1 / (1 + decay × rank), rank counted over the page's body links in document
 * order; and the site-wide discount for a template block found on more than
 * `prominenceSitewideShare` of the pages.
 */
export function observationFactors(
  pages: readonly PageLinks[],
  config: ProminenceConfig,
): { factors: Map<number, ObservationFactors>; sitewide: SitewideTemplate[] } {
  const pagesWith = new Map<string, number>();
  for (const p of pages) {
    const sigs = new Set(p.links.map((l) => l.templateSignature).filter((s) => s !== null));
    for (const s of sigs) pagesWith.set(s, (pagesWith.get(s) ?? 0) + 1);
  }
  const sitewide: SitewideTemplate[] = [...pagesWith]
    .map(([signature, n]) => ({ signature, pages: n, share: n / pages.length }))
    .filter((t) => t.share > config.prominenceSitewideShare)
    .sort((a, b) => b.pages - a.pages || cmp(a.signature, b.signature));
  const isSitewide = new Set(sitewide.map((t) => t.signature));

  const factors = new Map<number, ObservationFactors>();
  for (const p of pages) {
    const ordered = [...p.links].sort(
      (a, b) => a.positionIndex - b.positionIndex || a.observationId - b.observationId,
    );
    let rank = 0;
    for (const l of ordered) {
      const region = regionClass(l.domRegion);
      const regionWeight = config.prominenceRegionWeights[region];
      const bodyRank = region === "body" ? rank++ : null;
      const positionFactor =
        bodyRank === null ? 1 : 1 / (1 + config.prominencePositionDecay * bodyRank);
      const sitewideLink = l.templateSignature !== null && isSitewide.has(l.templateSignature);
      const sitewideDiscount = sitewideLink ? config.prominenceSitewideDiscount : 1;
      factors.set(l.observationId, {
        observationId: l.observationId,
        region,
        regionWeight,
        bodyRank,
        positionFactor,
        sitewide: sitewideLink,
        sitewideDiscount,
        weight: regionWeight * positionFactor * sitewideDiscount,
      });
    }
  }
  return { factors, sitewide };
}

/**
 * Pure: prominence, the structural stand-in for the patent's session counts.
 * W(u,v) = Σ over observations u→v of regionWeight × positionFactor × sitewideDiscount, and
 * ω(u,v) = W(u,v) / Σ_v W(u,v).
 *
 * With analytics, every source node with clicks on at least one of its edges uses clicks as W
 * for all its edges (0 for edges without clicks), so each row of ω is in one unit. Rows that do
 * not map to an existing edge are counted, not used.
 */
export function computeProminence(
  input: { readonly pages: readonly PageLinks[]; readonly analytics?: readonly NodeClicks[] },
  config: ProminenceConfig,
): Prominence {
  const { factors, sitewide } = observationFactors(input.pages, config);

  interface Acc {
    source: string;
    target: string;
    weight: number;
    observations: number;
    regions: Partial<Record<ProminenceRegion, number>>;
  }
  const acc = new Map<string, Acc>();
  const key = (s: string, t: string) => JSON.stringify([s, t]);
  let observations = 0;
  for (const p of input.pages) {
    for (const l of p.links) {
      if (l.target === null) continue;
      const f = factors.get(l.observationId) as ObservationFactors;
      const k = key(p.node, l.target);
      let a = acc.get(k);
      if (a === undefined) {
        a = { source: p.node, target: l.target, weight: 0, observations: 0, regions: {} };
        acc.set(k, a);
      }
      a.weight += f.weight;
      a.observations += 1;
      a.regions[f.region] = (a.regions[f.region] ?? 0) + 1;
      observations += 1;
    }
  }

  // Analytics: clicks per existing edge; a source is overridden when it has any clicks.
  const clicks = new Map<string, number>();
  let analytics: Prominence["stats"]["analytics"] = null;
  if (input.analytics !== undefined && input.analytics.length > 0) {
    const unmatched = { invalidUrl: 0, external: 0, selfLoop: 0, noLink: 0 };
    let matchedRows = 0;
    for (const r of input.analytics) {
      if (r.source === null || r.target === null) {
        if (r.reason === "external") unmatched.external += 1;
        else unmatched.invalidUrl += 1;
      } else if (r.source === r.target) unmatched.selfLoop += 1;
      else if (!acc.has(key(r.source, r.target))) unmatched.noLink += 1;
      else {
        matchedRows += 1;
        const k = key(r.source, r.target);
        clicks.set(k, (clicks.get(k) ?? 0) + r.clicks);
      }
    }
    analytics = { rows: input.analytics.length, matchedRows, unmatched, overriddenSources: 0 };
  }
  const overridden = new Set<string>();
  for (const [k, c] of clicks) if (c > 0) overridden.add((acc.get(k) as Acc).source);
  if (analytics !== null) analytics = { ...analytics, overriddenSources: overridden.size };

  const sorted = [...acc.values()].sort(
    (a, b) => cmp(a.source, b.source) || cmp(a.target, b.target),
  );
  const effective = (a: Acc) =>
    overridden.has(a.source) ? (clicks.get(key(a.source, a.target)) ?? 0) : a.weight;
  const totals = new Map<string, number>();
  for (const a of sorted) totals.set(a.source, (totals.get(a.source) ?? 0) + effective(a));

  const edges = sorted.map((a): ProminenceEdge => {
    const w = effective(a);
    const total = totals.get(a.source) as number;
    const isAnalytics = overridden.has(a.source);
    return {
      source: a.source,
      target: a.target,
      weight: w,
      omega: total > 0 ? w / total : 0,
      origin: isAnalytics ? "analytics" : "structural",
      structuralWeight: a.weight,
      clicks: isAnalytics ? w : null,
      observations: a.observations,
      regions: a.regions,
    };
  });

  return {
    version: PROMINENCE_VERSION,
    params: {
      prominenceRegionWeights: config.prominenceRegionWeights,
      prominencePositionDecay: config.prominencePositionDecay,
      prominenceSitewideShare: config.prominenceSitewideShare,
      prominenceSitewideDiscount: config.prominenceSitewideDiscount,
    },
    stats: {
      pages: input.pages.length,
      edges: edges.length,
      observations,
      sitewideTemplates: sitewide,
      analytics,
    },
    edges,
  };
}
