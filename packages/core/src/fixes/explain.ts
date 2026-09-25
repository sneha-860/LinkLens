import type { DiscoveryChannel } from "../discovery/channels.js";
import type { Issue } from "../audit/structural.js";
import type { Diagnosis, DiagnosisCase } from "../diagnosis/diagnose.js";
import { CASE_LABELS } from "../diagnosis/diagnose.js";
import type { ProminenceRegion } from "../config.js";
import type { ProminenceEdge } from "../prominence/weights.js";
import type { MatchedTerm } from "../semantic/ref.js";
import { parseReference } from "../url/rfc3986.js";
import type { CandidateAction } from "./candidates.js";
import type { DonorEffort } from "./effort.js";
import type { RescuedOrphan } from "./rescue.js";
import type { FixRecord } from "./scoring.js";

/** Bump whenever any template, number format or field can change. */
export const EXPLAIN_VERSION = "explain@1.0.0";
export const EXPLANATIONS_ARTEFACT = "explanations";

// ---------- deterministic formatting ----------

/** Path and query of a node (the site is implied), e.g. "/blog/post?page=2". */
export function shortUrl(node: string): string {
  const { path, query } = parseReference(node);
  const p = path === "" ? "/" : path;
  return query === undefined ? p : `${p}?${query}`;
}
/** Fixed two decimals (scores in [0, 1]). */
export const f2 = (x: number) => x.toFixed(2);
/** Three significant digits in exponent form (PageRank values), signed when asked. */
export const sci = (x: number, signed = false) =>
  `${signed && x >= 0 ? "+" : ""}${x.toExponential(2)}`;
/** One-decimal percentage, signed. */
export const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const quote = (terms: readonly MatchedTerm[]) => terms.map((t) => `'${t.term}'`).join(", ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CHANNEL_NAMES: Readonly<Record<DiscoveryChannel, string>> = {
  link_graph: "the link graph",
  xml_sitemap: "the XML sitemap",
  robots_sitemap: "a sitemap declared in robots.txt",
  html_sitemap: "the HTML sitemap",
  feed: "the RSS/Atom feed",
  llms_txt: "llms.txt",
};

const REGION_NAMES: Readonly<Record<ProminenceRegion, string>> = {
  body: "the main content",
  breadcrumb: "the breadcrumb",
  aside: "the sidebar",
  header: "the header",
  nav: "the navigation",
  pagination: "the pagination",
  footer: "the footer",
};
const regionList = (regions: ProminenceEdge["regions"]) =>
  (Object.keys(regions) as ProminenceRegion[]).map((r) => REGION_NAMES[r]).join(" and ");

// ---------- why the target needs help ----------

export type TargetNeed =
  | { readonly kind: "orphan"; readonly revealedBy: DiscoveryChannel[] }
  | { readonly kind: "deep-page"; readonly depth: number; readonly threshold: number }
  | {
      readonly kind: "weak-authority";
      readonly pagerank: number;
      readonly percentile: number;
      readonly threshold: number;
    }
  | { readonly kind: "v4" | "v3"; readonly from: number };

const NEED_ORDER: readonly TargetNeed["kind"][] = [
  "orphan",
  "deep-page",
  "weak-authority",
  "v4",
  "v3",
];

/** A target's needs from its audit issues and the diagnoses naming it, in a fixed order. */
export function targetNeeds(
  target: string,
  issues: readonly Pick<Issue, "type" | "node" | "evidence">[],
  diagnoses: readonly Pick<Diagnosis, "case" | "target">[],
): TargetNeed[] {
  const needs: TargetNeed[] = [];
  for (const i of issues) {
    if (i.node !== target) continue;
    const e = i.evidence as Record<string, unknown>;
    if (i.type === "orphan") {
      const channels = (e["channels"] ?? []) as DiscoveryChannel[];
      needs.push({ kind: "orphan", revealedBy: channels.filter((c) => c !== "link_graph") });
    } else if (i.type === "deep-page") {
      needs.push({
        kind: "deep-page",
        depth: e["depth"] as number,
        threshold: e["threshold"] as number,
      });
    } else if (i.type === "weak-authority") {
      needs.push({
        kind: "weak-authority",
        pagerank: e["pagerank"] as number,
        percentile: e["percentile"] as number,
        threshold: e["threshold"] as number,
      });
    }
  }
  for (const c of ["v4", "v3"] as const) {
    const from = diagnoses.filter((d) => d.target === target && d.case === c).length;
    if (from > 0) needs.push({ kind: c, from });
  }
  return needs.sort((a, b) => NEED_ORDER.indexOf(a.kind) - NEED_ORDER.indexOf(b.kind));
}

export function describeNeed(n: TargetNeed): string {
  switch (n.kind) {
    case "orphan":
      return `is linked from nowhere and was found only via ${n.revealedBy.map((c) => CHANNEL_NAMES[c]).join(" and ")}`;
    case "deep-page":
      return `is ${plural(n.depth, "click")} from the home page (deeper than ${n.threshold})`;
    case "weak-authority":
      return `is in the bottom ${n.percentile}% by PageRank (${sci(n.pagerank)} < ${sci(n.threshold)})`;
    case "v4":
      return `is missing a link from ${plural(n.from, "related page")} (v4)`;
    case "v3":
      return `is buried: ${n.from === 1 ? "1 related page links" : `${n.from} related pages link`} to it only faintly (v3)`;
  }
}

// ---------- fixes and rescues ----------

export interface FixExplanation {
  readonly id: string;
  readonly kind: "fix" | "rescue";
  readonly donor: string;
  readonly target: string;
  readonly type: CandidateAction;
  readonly needs: TargetNeed[];
  readonly donorEvidence: {
    readonly ref: number;
    /** The top matched n-grams behind REF, largest share first. */
    readonly matched: MatchedTerm[];
    /** null when a page has no embedding (e.g. an orphan). */
    readonly cosine: number | null;
  };
  readonly link: {
    readonly exists: boolean;
    readonly omega: number | null;
    readonly regions: ProminenceEdge["regions"];
  };
  readonly impact: {
    readonly prBefore: number;
    readonly prAfter: number;
    readonly deltaPr: number;
    /** ΔPR as a percentage of PR before (null when PR before is 0). */
    readonly deltaPrPct: number | null;
    readonly depthBefore: number | null;
    readonly depthAfter: number | null;
    readonly deltaDepth: number | null;
  };
  readonly effort: { readonly kappa: number; readonly templateReach: number };
  /** The pair's diagnosis (null: not one of the four cases, or an orphan rescue). */
  readonly case: { readonly label: DiagnosisCase | null; readonly name: string };
  readonly score: number | null;
  readonly rank: number | null;
  /** One line per aspect, then the one-sentence summary. */
  readonly lines: string[];
  readonly sentence: string;
}

export interface FixExplanationInput {
  readonly kind: "fix" | "rescue";
  readonly id: string;
  readonly donor: string;
  readonly target: string;
  readonly type: CandidateAction;
  readonly ref: number;
  readonly rho: number | null;
  readonly cosine: number | null;
  readonly matched: readonly MatchedTerm[];
  readonly edge: Pick<ProminenceEdge, "omega" | "regions"> | null;
  readonly prBefore: number;
  readonly prAfter: number;
  readonly deltaPr: number;
  readonly depthBefore: number | null;
  readonly depthAfter: number | null;
  readonly deltaDepth: number | null;
  readonly effort: Pick<DonorEffort, "kappa" | "templateReach">;
  readonly needs: readonly TargetNeed[];
  readonly diagnosis: DiagnosisCase | null;
  readonly alpha: number;
  readonly epsilon: number;
  readonly score: number | null;
  readonly rank: number | null;
  readonly explainTerms: number;
}

function depthPhrase(before: number | null, after: number | null): string {
  if (after === null) return "stays unreachable";
  if (before === null) return `becomes reachable, ${plural(after, "click")} from the home page`;
  if (after === before) return `stays ${plural(after, "click")} deep`;
  return `goes from ${before} to ${plural(after, "click")} deep (${after - before})`;
}

/** Pure: the explanation of one fix (or orphan rescue) from its evidence. */
export function explainFix(x: FixExplanationInput): FixExplanation {
  const matched = x.matched.slice(0, x.explainTerms);
  const deltaPrPct = x.prBefore > 0 ? (100 * x.deltaPr) / x.prBefore : null;
  const donor = shortUrl(x.donor);
  const target = shortUrl(x.target);
  const needs = x.needs.length === 0 ? ["is a fix target"] : x.needs.map(describeNeed);
  const caseName =
    x.diagnosis !== null
      ? `${x.diagnosis} (${CASE_LABELS[x.diagnosis]})`
      : x.kind === "rescue"
        ? "orphan rescue (not diagnosed: the orphan has no link to judge)"
        : `not one of the four cases (ρ ${f2(x.rho ?? 0)} ≤ α ${x.alpha})`;

  const linkLine =
    x.edge === null
      ? `There is no link from ${donor} to ${target} yet.`
      : x.type === "make-visible"
        ? `${donor} already links to ${target} from ${regionList(x.edge.regions)}, with low prominence ω ${f2(x.edge.omega)} (< α ${x.alpha}).`
        : `${donor} links to ${target} only from ${regionList(x.edge.regions)} (ω ${f2(x.edge.omega)}); a link in the main content is missing.`;
  const reach =
    x.effort.templateReach > 1
      ? `its widest body block is a template on ${x.effort.templateReach} pages`
      : "its body blocks are unique to the page";
  const impact = `PageRank ${sci(x.deltaPr, true)}${deltaPrPct === null ? "" : ` (${pct(deltaPrPct)})`}`;
  const verb = x.type === "make-visible" ? "Make the link" : "Add a link";

  const lines = [
    `Why the target: ${target} ${needs.join("; ")}.`,
    `Why this donor: REF(u,v) ${f2(x.ref)} > ε ${x.epsilon}` +
      (matched.length > 0 ? `, on ${quote(matched)}` : "") +
      (x.cosine === null ? "; no embedding cosine" : `; cosine ${f2(x.cosine)}`) +
      ".",
    linkLine,
    `Predicted: ${impact}; ${target} ${depthPhrase(x.depthBefore, x.depthAfter)}.`,
    `Effort: κ ${x.effort.kappa} (${plural(x.effort.kappa, "body link block")}); ${reach}.`,
    `Case: ${caseName}.`,
  ];
  const sentence =
    `${verb} from ${donor} to ${target}${x.type === "make-visible" ? " more visible" : ""}: ` +
    `the target ${needs[0]}; REF ${f2(x.ref)}` +
    (matched.length > 0 ? ` on ${quote(matched.slice(0, 2))}` : "") +
    `; predicted ${impact}; κ ${x.effort.kappa}.`;

  return {
    id: x.id,
    kind: x.kind,
    donor: x.donor,
    target: x.target,
    type: x.type,
    needs: [...x.needs],
    donorEvidence: { ref: x.ref, matched, cosine: x.cosine },
    link: {
      exists: x.edge !== null,
      omega: x.edge?.omega ?? null,
      regions: x.edge?.regions ?? {},
    },
    impact: {
      prBefore: x.prBefore,
      prAfter: x.prAfter,
      deltaPr: x.deltaPr,
      deltaPrPct,
      depthBefore: x.depthBefore,
      depthAfter: x.depthAfter,
      deltaDepth: x.deltaDepth,
    },
    effort: { kappa: x.effort.kappa, templateReach: x.effort.templateReach },
    case: { label: x.diagnosis, name: caseName },
    score: x.score,
    rank: x.rank,
    lines,
    sentence,
  };
}

// ---------- diagnoses ----------

export interface DiagnosisExplanation {
  readonly id: string;
  readonly kind: "diagnosis";
  readonly case: DiagnosisCase;
  readonly label: string;
  readonly source: string;
  readonly target: string;
  readonly rho: number;
  readonly omega: number;
  readonly alpha: number;
  readonly ref: number;
  readonly matched: MatchedTerm[];
  readonly link: { readonly exists: boolean; readonly regions: ProminenceEdge["regions"] };
  readonly severity: number;
  readonly recommendation: Diagnosis["recommendation"];
  readonly sentence: string;
}

/** Pure: the explanation of one diagnosis. */
export function explainDiagnosis(
  d: Pick<
    Diagnosis,
    | "id"
    | "case"
    | "label"
    | "source"
    | "target"
    | "rho"
    | "omega"
    | "ref"
    | "matched"
    | "severity"
    | "recommendation"
  > & { readonly edge: Pick<ProminenceEdge, "regions"> | null },
  alpha: number,
  explainTerms: number,
): DiagnosisExplanation {
  const u = shortUrl(d.source);
  const v = shortUrl(d.target);
  const matched = d.matched.slice(0, explainTerms);
  const on = matched.length > 0 ? ` on ${quote(matched)}` : "";
  const where = d.edge === null ? "" : ` from ${regionList(d.edge.regions)}`;
  const related = `${u} covers ${v}'s topic (ρ ${f2(d.rho)} > α ${alpha}; REF ${f2(d.ref)}${on})`;
  const sentence = {
    v4: `${u} → ${v} is missing (v4): ${related} but does not link to it. Recommendation: add a link (severity ${f2(d.severity)}).`,
    v3: `${u} → ${v} is buried (v3): ${related} but links to it only${where} with ω ${f2(d.omega)} < α ${alpha}. Recommendation: make the link more visible (severity ${f2(d.severity)}).`,
    v2: `${u} → ${v} is good (v2): ${related} and links to it prominently${where} (ω ${f2(d.omega)} ≥ α ${alpha}). No action needed.`,
    v1: `${u} → ${v} is misleading or low-value (v1): it links prominently${where} (ω ${f2(d.omega)} ≥ α ${alpha}) but the pages are not related (ρ ${f2(d.rho)} ≤ α ${alpha}; REF ${f2(d.ref)}). Recommendation: flag for review or removal (never simulated; severity ${f2(d.severity)}).`,
  }[d.case];
  return {
    id: d.id,
    kind: "diagnosis",
    case: d.case,
    label: d.label,
    source: d.source,
    target: d.target,
    rho: d.rho,
    omega: d.omega,
    alpha,
    ref: d.ref,
    matched,
    link: { exists: d.edge !== null, regions: d.edge?.regions ?? {} },
    severity: d.severity,
    recommendation: d.recommendation,
    sentence,
  };
}

// ---------- assembling from the pipeline's records ----------

export interface ExplainInput {
  readonly fixes: readonly FixRecord[];
  readonly rescues: readonly RescuedOrphan[];
  readonly diagnoses: readonly Diagnosis[];
  readonly issues: readonly Pick<Issue, "type" | "node" | "evidence">[];
  /** Matched n-grams of a (donor, target) pair from the REF matrix. */
  readonly matched: (u: string, v: string) => readonly MatchedTerm[];
  readonly edges: readonly ProminenceEdge[];
  readonly effort: ReadonlyMap<string, Pick<DonorEffort, "kappa" | "templateReach">>;
  readonly alpha: number;
  readonly epsilon: number;
  readonly explainTerms: number;
}

export interface Explanations {
  readonly fixes: FixExplanation[];
  readonly rescues: FixExplanation[];
  readonly diagnoses: DiagnosisExplanation[];
}

/** Pure: explain every fix (in rank order), every rescue donor and every diagnosis. */
export function explainAll(input: ExplainInput): Explanations {
  const key = (s: string, t: string) => JSON.stringify([s, t]);
  const edges = new Map(input.edges.map((e) => [key(e.source, e.target), e]));
  const diagnosed = new Map(input.diagnoses.map((d) => [key(d.source, d.target), d.case]));
  const effortOf = (n: string) => input.effort.get(n) ?? { kappa: 1, templateReach: 1 };

  const fixes = input.fixes.map((f) =>
    explainFix({
      kind: "fix",
      id: f.id,
      donor: f.donor,
      target: f.target,
      type: f.type,
      ref: f.ref,
      rho: f.rho,
      cosine: f.cosine,
      matched: input.matched(f.donor, f.target),
      edge: edges.get(key(f.donor, f.target)) ?? null,
      prBefore: f.prBefore,
      prAfter: f.prAfter,
      deltaPr: f.deltaPr,
      depthBefore: f.depthBefore,
      depthAfter: f.depthAfter,
      deltaDepth: f.deltaDepth,
      effort: effortOf(f.donor),
      needs: targetNeeds(f.target, input.issues, input.diagnoses),
      diagnosis: diagnosed.get(key(f.donor, f.target)) ?? null,
      alpha: input.alpha,
      epsilon: input.epsilon,
      score: f.score,
      rank: f.rank,
      explainTerms: input.explainTerms,
    }),
  );

  const rescues = input.rescues.flatMap((o) =>
    o.donors.map((d) =>
      explainFix({
        kind: "rescue",
        id: `rescue:${d.donor}->${o.node}`,
        donor: d.donor,
        target: o.node,
        type: "add-link",
        ref: d.ref,
        rho: null,
        cosine: null,
        matched: d.matched,
        edge: null,
        prBefore: d.prBefore,
        prAfter: d.prAfter,
        deltaPr: d.deltaPr,
        depthBefore: null,
        depthAfter: d.depthAfter,
        deltaDepth: null,
        effort: effortOf(d.donor),
        needs: [{ kind: "orphan", revealedBy: o.revealedBy }],
        diagnosis: null,
        alpha: input.alpha,
        epsilon: input.epsilon,
        score: null,
        rank: d.rank,
        explainTerms: input.explainTerms,
      }),
    ),
  );

  const diagnoses = input.diagnoses.map((d) =>
    explainDiagnosis(
      { ...d, edge: edges.get(key(d.source, d.target)) ?? null },
      input.alpha,
      input.explainTerms,
    ),
  );
  return { fixes, rescues, diagnoses };
}
