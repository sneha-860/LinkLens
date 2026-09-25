import type { LinkLensConfig } from "../config.js";
import type { DiscoveryChannel } from "../discovery/channels.js";
import { ref, type MatchedTerm, type RefVariant } from "../semantic/ref.js";
import { idfOf, type RawDocument, type TextModel } from "../text/model.js";
import { terms } from "../text/tokenise.js";
import { sectionOf, sectionRelation, utilityMatcher, type SectionRelation } from "./candidates.js";
import type { CounterfactualResult } from "./counterfactual.js";

/** Bump whenever the output can change (orphan weighting, admission, the two ranking stages). */
export const RESCUE_VERSION = "rescue@1.1.0";
export const RESCUE_ARTEFACT = "orphan-rescue";

type RescueConfig = Pick<
  LinkLensConfig,
  | "epsilon"
  | "candidateMaxPerTarget"
  | "candidateUtilityPatterns"
  | "candidateSectionBlocking"
  | "candidateSiblingSections"
  | "candidateTopLevelIsSibling"
  | "rescueTopK"
  | "refExplainTerms"
>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fmt = (x: number) => Number(x.toPrecision(4)).toString();

/**
 * S_B = Title ∪ Body of a page outside the site's text model (an orphan), weighted with the
 * site's statistics so the model itself does not change: the model's tokeniser settings, its
 * boilerplate list (dropped), and its IDF. A term the site never uses gets the IDF of df = 0.
 */
export function externalTargetWeights(
  doc: Pick<RawDocument, "title" | "body">,
  model: TextModel,
): Map<string, number> {
  const opts = { minTokenLength: model.params.minTokenLength, maxNgram: model.params.maxNgram };
  const dropped = new Set(model.dropped.map((d) => d.term));
  const unseen = idfOf(model.stats.documents, 0);
  const counts = new Map<string, number>();
  for (const text of [...doc.title, ...doc.body]) {
    for (const t of terms(text, opts)) if (!dropped.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return new Map(
    [...counts.keys()].sort().map((t) => [t, (counts.get(t) as number) * (model.idf[t] ?? unseen)]),
  );
}

/** The matched terms of a target in a donor, by share of REF (largest first, ties by term). */
export function matchedTerms(
  donor: ReadonlySet<string>,
  target: ReadonlyMap<string, number>,
  variant: RefVariant,
  limit: number,
): MatchedTerm[] {
  let total = 0;
  for (const w of target.values()) total += variant === "weighted" ? w : 1;
  if (total === 0) return [];
  return [...target]
    .filter(([t]) => donor.has(t))
    .map(([term, w]) => ({ term, contribution: (variant === "weighted" ? w : 1) / total }))
    .sort((a, b) => b.contribution - a.contribution || cmp(a.term, b.term))
    .slice(0, limit);
}

/** A reconciled orphan and, if it could be fetched, its page. */
export interface OrphanInput {
  readonly node: string;
  /** Raw URLs the channels listed for it. */
  readonly urls: readonly string[];
  /** Every channel that found it (non-link channels revealed it as an orphan). */
  readonly channels: readonly DiscoveryChannel[];
  readonly sources: Partial<Record<DiscoveryChannel, (string | null)[]>>;
  /** Title/h1 and body of the fetched page; null when there is none. */
  readonly page: Pick<RawDocument, "title" | "body"> | null;
  /** The rescue fetch, if one was made. */
  readonly fetch: {
    readonly requestedUrl: string;
    readonly statusCode: number | null;
    readonly contentType: string | null;
    readonly error: string | null;
  } | null;
}

export const RESCUE_REJECTIONS = [
  "unreachable",
  "utility",
  "section",
  "ref-not-above-epsilon",
  "capped",
] as const;
export type RescueRejection = (typeof RESCUE_REJECTIONS)[number];

export interface RescueShortlistEntry {
  readonly donor: string;
  readonly ref: number;
  /** 1 = highest REF(u, orphan). */
  readonly refRank: number;
  readonly depth: number;
  readonly section: {
    readonly donor: string;
    readonly orphan: string;
    readonly relation: SectionRelation;
  };
  /** The refExplainTerms matched n-grams with the largest share of REF (ties by term). */
  readonly matched: MatchedTerm[];
}

export interface RescueShortlist {
  readonly orphan: OrphanInput;
  /** Why no donor could be scored, when that is the case. */
  readonly status: "scored" | "no-page" | "no-text";
  readonly shortlist: RescueShortlistEntry[];
  readonly rejected: Record<RescueRejection, number>;
}

/**
 * Stage 1: for each orphan, the donors with REF(u, orphan) > ε, highest first, capped at
 * candidateMaxPerTarget. A donor must be a site page with text that is reachable from the home
 * page (a link from an unreachable page rescues nothing), not a utility page, and in the same or
 * a sibling section (or top level), as for fix candidates.
 */
export function rescueShortlists(
  orphans: readonly OrphanInput[],
  model: TextModel,
  depth: ReadonlyMap<string, number>,
  variant: RefVariant,
  config: RescueConfig,
): RescueShortlist[] {
  const isUtility = utilityMatcher(config.candidateUtilityPatterns);
  const donors = [...model.documents].sort((a, b) => cmp(a.node, b.node));
  const zero = () =>
    Object.fromEntries(RESCUE_REJECTIONS.map((r) => [r, 0])) as Record<RescueRejection, number>;

  return [...orphans]
    .sort((a, b) => cmp(a.node, b.node))
    .map((orphan): RescueShortlist => {
      const rejected = zero();
      if (orphan.page === null) return { orphan, status: "no-page", shortlist: [], rejected };
      const target = externalTargetWeights(orphan.page, model);
      if (target.size === 0) return { orphan, status: "no-text", shortlist: [], rejected };
      const oSection = sectionOf(orphan.node);
      const admitted: Omit<RescueShortlistEntry, "refRank">[] = [];
      for (const d of donors) {
        if (d.node === orphan.node) continue;
        const dDepth = depth.get(d.node);
        if (dDepth === undefined || dDepth < 0) {
          rejected.unreachable += 1;
          continue;
        }
        if (isUtility(d.node) !== null) {
          rejected.utility += 1;
          continue;
        }
        const dSection = sectionOf(d.node);
        const relation = sectionRelation(dSection, oSection, config);
        if (relation === null) {
          rejected.section += 1;
          continue;
        }
        const r = ref(new Set(d.donor), target, variant);
        if (!(r > config.epsilon)) {
          rejected["ref-not-above-epsilon"] += 1;
          continue;
        }
        admitted.push({
          donor: d.node,
          ref: r,
          depth: dDepth,
          section: { donor: dSection, orphan: oSection, relation },
          matched: matchedTerms(new Set(d.donor), target, variant, config.refExplainTerms),
        });
      }
      admitted.sort((a, b) => b.ref - a.ref || cmp(a.donor, b.donor));
      const kept = admitted.slice(0, config.candidateMaxPerTarget);
      rejected.capped = admitted.length - kept.length;
      return {
        orphan,
        status: "scored",
        shortlist: kept.map((e, i) => ({ ...e, refRank: i + 1 })),
        rejected,
      };
    });
}

/** The id of a rescue scenario (the counterfactual adds donor → orphan). */
export const rescueId = (donor: string, orphan: string) => `rescue:${donor}->${orphan}`;

export interface RescueDonor {
  /** 1 = the largest ΔPR for the orphan. */
  readonly rank: number;
  readonly donor: string;
  readonly ref: number;
  readonly refRank: number;
  /** The matched n-grams behind REF (for explanations). */
  readonly matched: MatchedTerm[];
  /** PR of the orphan before and after the link. */
  readonly prBefore: number;
  readonly prAfter: number;
  readonly deltaPr: number;
  readonly deltaPrL1: number;
  /** The orphan's click depth once linked (the donor's depth + 1). */
  readonly depthAfter: number | null;
  readonly reasons: string[];
}

export interface RescuedOrphan {
  readonly node: string;
  readonly urls: string[];
  readonly channels: DiscoveryChannel[];
  /** The non-link channels, i.e. what revealed the page as an orphan. */
  readonly revealedBy: DiscoveryChannel[];
  readonly sources: Partial<Record<DiscoveryChannel, (string | null)[]>>;
  readonly status: RescueShortlist["status"];
  readonly fetch: OrphanInput["fetch"];
  readonly shortlisted: number;
  readonly rejected: Record<RescueRejection, number>;
  /** The top rescueTopK donors by ΔPR (from the REF shortlist). */
  readonly donors: RescueDonor[];
}

/**
 * Stage 2: order each orphan's REF shortlist by the counterfactual ΔPR of the orphan (ties by
 * REF, then donor) and keep the top rescueTopK, each with a readable reason per rule.
 */
export function rankRescue(
  shortlists: readonly RescueShortlist[],
  results: ReadonlyMap<string, CounterfactualResult>,
  config: Pick<LinkLensConfig, "epsilon" | "rescueTopK">,
): RescuedOrphan[] {
  return shortlists.map((s) => {
    const revealedBy = s.orphan.channels.filter((c) => c !== "link_graph");
    const scored = s.shortlist.map((e) => {
      const r = results.get(rescueId(e.donor, s.orphan.node));
      if (r === undefined)
        throw new Error(`no counterfactual result for ${rescueId(e.donor, s.orphan.node)}`);
      return { e, r };
    });
    scored.sort(
      (a, b) =>
        b.r.deltaPrTarget - a.r.deltaPrTarget || b.e.ref - a.e.ref || cmp(a.e.donor, b.e.donor),
    );
    const via = revealedBy
      .map((c) => {
        const docs = (s.orphan.sources[c] ?? []).filter((d): d is string => d !== null);
        return docs.length === 0 ? c : `${c} (${docs.join(", ")})`;
      })
      .join("; ");
    return {
      node: s.orphan.node,
      urls: [...s.orphan.urls],
      channels: [...s.orphan.channels],
      revealedBy,
      sources: s.orphan.sources,
      status: s.status,
      fetch: s.orphan.fetch,
      shortlisted: s.shortlist.length,
      rejected: s.rejected,
      donors: scored.slice(0, config.rescueTopK).map(({ e, r }, i) => ({
        rank: i + 1,
        donor: e.donor,
        ref: e.ref,
        refRank: e.refRank,
        matched: e.matched,
        prBefore: r.prBefore,
        prAfter: r.prAfter,
        deltaPr: r.deltaPrTarget,
        deltaPrL1: r.deltaPrL1,
        depthAfter: r.depthAfter,
        reasons: [
          `orphan revealed by ${via}; no reachable page links to it`,
          `donor is reachable from the home page (depth ${e.depth})`,
          "donor is not a utility page",
          e.section.relation === "same"
            ? `same section ('${e.section.donor}')`
            : e.section.relation === "sibling"
              ? `sibling sections ('${e.section.donor}' ~ '${e.section.orphan}')`
              : e.section.relation === "top-level"
                ? "a top-level page is involved (any section)"
                : "section blocking is off",
          `REF(u, orphan) = ${fmt(e.ref)} > ε = ${config.epsilon} (#${e.refRank} by REF of ${s.shortlist.length})`,
          `linking it adds ΔPR = ${r.deltaPrTarget.toExponential(3)} and puts it ${r.depthAfter} clicks from the home page`,
        ],
      })),
    };
  });
}
