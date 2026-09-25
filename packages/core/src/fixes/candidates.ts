import type { PolicyId } from "../canonicalise/index.js";
import type { LinkLensConfig } from "../config.js";
import { insertArtefact } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import type { Issue } from "../audit/structural.js";
import { loadAudit } from "../audit/structural.js";
import { diagnose, type Diagnosis } from "../diagnosis/diagnose.js";
import { loadProminence, type RunProminence } from "../prominence/run.js";
import type { ProminenceEdge } from "../prominence/weights.js";
import { refMatrix, type RefMatrix, type RefVariant } from "../semantic/ref.js";
import { loadTextModel } from "../text/run.js";
import { parseReference } from "../url/rfc3986.js";

/** Bump whenever the output can change (target selection, admission rules, cap, reasons). */
export const CANDIDATES_VERSION = "candidates@1.0.0";
export const CANDIDATES_ARTEFACT = "fix-candidates";

/** Why a node is a fix target. */
export const TARGET_REASONS = ["orphan", "deep-page", "weak-authority", "v4", "v3"] as const;
export type TargetReason = (typeof TARGET_REASONS)[number];

export type CandidateAction = "add-link" | "make-visible";

/** Why a donor was not admitted for a target (the first rule it failed). */
export const REJECTIONS = [
  "self",
  "utility",
  "section",
  "ref-not-above-epsilon",
  "prominent-link",
  "capped",
] as const;
export type Rejection = (typeof REJECTIONS)[number];

type CandidateConfig = Pick<
  LinkLensConfig,
  | "epsilon"
  | "alpha"
  | "candidateMaxPerTarget"
  | "candidateUtilityPatterns"
  | "candidateSectionBlocking"
  | "candidateSiblingSections"
  | "candidateTopLevelIsSibling"
>;

export type SectionRelation = "same" | "sibling" | "top-level" | "unblocked";

export interface Candidate {
  /** Stable id: `${action}:${donor}->${target}`. */
  readonly id: string;
  readonly donor: string;
  readonly target: string;
  readonly action: CandidateAction;
  /** 1 = highest REF among the target's kept candidates. */
  readonly rank: number;
  readonly ref: number;
  readonly rho: number;
  /** The existing link u→v, if any (ω, and whether any observation is in the body). */
  readonly existingLink: {
    readonly omega: number;
    readonly bodyLink: boolean;
    readonly regions: ProminenceEdge["regions"];
  } | null;
  readonly targetReasons: TargetReason[];
  /** The diagnosis of this exact pair, if it was v4 or v3. */
  readonly diagnosis: "v4" | "v3" | null;
  readonly section: {
    readonly donor: string;
    readonly target: string;
    readonly relation: SectionRelation;
  };
  /** Why the candidate was admitted, one line per rule, readable as is. */
  readonly reasons: string[];
}

export interface TargetSummary {
  readonly node: string;
  readonly reasons: TargetReason[];
  /** The target has a text document (was crawled as HTML); without one REF is undefined. */
  readonly hasText: boolean;
  /** Donors that passed every rule, before the cap. */
  readonly admitted: number;
  readonly kept: number;
  readonly rejected: Record<Rejection, number>;
}

export interface CandidateList {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly refVersion: string;
  readonly refVariant: RefVariant;
  readonly epsilon: number;
  readonly alpha: number;
  readonly params: Pick<
    CandidateConfig,
    | "candidateMaxPerTarget"
    | "candidateUtilityPatterns"
    | "candidateSectionBlocking"
    | "candidateSiblingSections"
    | "candidateTopLevelIsSibling"
  >;
  readonly stats: {
    readonly targets: number;
    readonly targetsByReason: Record<TargetReason, number>;
    readonly targetsWithoutText: number;
    readonly candidates: number;
    readonly byAction: Record<CandidateAction, number>;
    readonly rejected: Record<Rejection, number>;
  };
  /** Sorted by node. */
  readonly targets: TargetSummary[];
  /** Sorted by target, then rank. */
  readonly candidates: Candidate[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fmt = (x: number) => Number(x.toPrecision(4)).toString();

/**
 * Fix targets: orphans, deep pages and weak-authority pages from the structural audit, and the
 * targets of v4 (missing) and v3 (buried) diagnoses. A node can have several reasons.
 */
export function candidateTargets(
  issues: readonly Pick<Issue, "type" | "node">[],
  diagnoses: readonly Pick<Diagnosis, "case" | "target">[],
): Map<string, Set<TargetReason>> {
  const targets = new Map<string, Set<TargetReason>>();
  const add = (node: string, reason: TargetReason) => {
    let r = targets.get(node);
    if (r === undefined) targets.set(node, (r = new Set()));
    r.add(reason);
  };
  for (const i of issues) {
    if (i.type === "orphan" || i.type === "deep-page" || i.type === "weak-authority") {
      add(i.node, i.type);
    }
  }
  for (const d of diagnoses) if (d.case === "v4" || d.case === "v3") add(d.target, d.case);
  return targets;
}

/**
 * A node's section: its first path segment when the path has at least two segments
 * ("/blog/post" and "/blog/" → "blog"); otherwise "" (top level: "/", "/about", "/blog").
 */
export function sectionOf(node: string): string {
  const segments = parseReference(node).path.split("/").slice(1);
  return segments.length >= 2 ? (segments[0] as string) : "";
}

/** How donor and target sections relate, or null when section blocking rejects the pair. */
export function sectionRelation(
  donor: string,
  target: string,
  config: Pick<
    CandidateConfig,
    "candidateSectionBlocking" | "candidateSiblingSections" | "candidateTopLevelIsSibling"
  >,
): SectionRelation | null {
  if (!config.candidateSectionBlocking) return "unblocked";
  if (donor === target) return "same";
  if (config.candidateTopLevelIsSibling && (donor === "" || target === "")) return "top-level";
  if (config.candidateSiblingSections.some((g) => g.includes(donor) && g.includes(target))) {
    return "sibling";
  }
  return null;
}

/** A matcher for utility pages (tested against the URL's path and query). */
export function utilityMatcher(patterns: readonly string[]): (node: string) => string | null {
  const res = patterns.map((p) => ({ p, re: new RegExp(p, "i") }));
  return (node) => {
    const { path, query } = parseReference(node);
    const target = query === undefined ? path : `${path}?${query}`;
    return res.find(({ re }) => re.test(target))?.p ?? null;
  };
}

export interface CandidateInput {
  readonly targets: ReadonlyMap<string, ReadonlySet<TargetReason>>;
  /** REF matrix: its nodes are the site's HTML pages with text (the donor pool). */
  readonly ref: RefMatrix;
  /** Prominence edges (existing links with ω and regions). */
  readonly edges: readonly ProminenceEdge[];
  readonly diagnoses: readonly Pick<Diagnosis, "case" | "source" | "target">[];
}

/**
 * Pure: for each target v, every admissible donor u, capped at candidateMaxPerTarget by REF.
 * Admission rules, in order (the first failure is what a rejection is counted as):
 * 1. u is a same-site HTML page with text (the REF matrix's nodes) and u ≠ v;
 * 2. u is not a utility page (candidateUtilityPatterns);
 * 3. u and v are in the same section, sibling sections, or one is top level (when blocking);
 * 4. REF(u,v) > ε;
 * 5. there is no body link u→v (action add-link), or the body link has ω(u,v) < α
 *    (action make-visible); a body link with ω ≥ α is already prominent.
 */
export function generateCandidates(
  input: CandidateInput,
  config: CandidateConfig,
): Omit<CandidateList, "runId" | "policyVersion"> {
  const { ref } = input;
  const key = (s: string, t: string) => JSON.stringify([s, t]);
  const refs = new Map<string, RefMatrix["entries"][number]>();
  for (const e of ref.entries) {
    refs.set(key(ref.nodes[e.source] as string, ref.nodes[e.target] as string), e);
  }
  const edges = new Map(input.edges.map((e) => [key(e.source, e.target), e]));
  const diagnosed = new Map<string, "v4" | "v3">();
  for (const d of input.diagnoses) {
    if (d.case === "v4" || d.case === "v3") diagnosed.set(key(d.source, d.target), d.case);
  }
  const isUtility = utilityMatcher(config.candidateUtilityPatterns);
  const donors = [...ref.nodes].sort(cmp);
  const utility = new Map(donors.map((u) => [u, isUtility(u)]));
  const section = new Map(donors.map((u) => [u, sectionOf(u)]));
  const hasText = new Set(ref.nodes);

  const zero = () => Object.fromEntries(REJECTIONS.map((r) => [r, 0])) as Record<Rejection, number>;
  const rejectedTotal = zero();
  const targets: TargetSummary[] = [];
  const candidates: Candidate[] = [];

  for (const v of [...input.targets.keys()].sort(cmp)) {
    const reasons = TARGET_REASONS.filter((r) => input.targets.get(v)?.has(r));
    const rejected = zero();
    if (!hasText.has(v)) {
      targets.push({ node: v, reasons, hasText: false, admitted: 0, kept: 0, rejected });
      continue;
    }
    const vSection = sectionOf(v);
    const admitted: Omit<Candidate, "rank">[] = [];
    for (const u of donors) {
      const reject = (r: Rejection) => {
        rejected[r] += 1;
      };
      if (u === v) {
        reject("self");
        continue;
      }
      if (utility.get(u) !== null) {
        reject("utility");
        continue;
      }
      const uSection = section.get(u) as string;
      const relation = sectionRelation(uSection, vSection, config);
      if (relation === null) {
        reject("section");
        continue;
      }
      const r = refs.get(key(u, v));
      if (r === undefined || !(r.ref > config.epsilon)) {
        reject("ref-not-above-epsilon");
        continue;
      }
      const edge = edges.get(key(u, v));
      const bodyLink = (edge?.regions.body ?? 0) > 0;
      if (edge !== undefined && bodyLink && edge.omega >= config.alpha) {
        reject("prominent-link");
        continue;
      }
      const action: CandidateAction = bodyLink ? "make-visible" : "add-link";
      const diagnosis = diagnosed.get(key(u, v)) ?? null;
      const why: string[] = [
        `target: ${reasons.join(", ")}`,
        "donor is a same-site HTML page with text",
        "donor is not a utility page",
        sectionReason(relation, uSection, vSection),
        `REF(u,v) = ${fmt(r.ref)} > ε = ${config.epsilon}`,
        edge === undefined
          ? "no link u→v yet: add a body link"
          : bodyLink
            ? `body link with low prominence ω = ${fmt(edge.omega)} < α = ${config.alpha}: make it more visible`
            : `linked only from ${Object.keys(edge.regions).join(", ")}: add a body link`,
      ];
      if (diagnosis !== null)
        why.push(
          `diagnosed ${diagnosis} (${diagnosis === "v4" ? "missing" : "buried"}) for this pair`,
        );
      admitted.push({
        id: `${action}:${u}->${v}`,
        donor: u,
        target: v,
        action,
        ref: r.ref,
        rho: r.rho,
        existingLink:
          edge === undefined ? null : { omega: edge.omega, bodyLink, regions: edge.regions },
        targetReasons: reasons,
        diagnosis,
        section: { donor: uSection, target: vSection, relation },
        reasons: why,
      });
    }
    admitted.sort((a, b) => b.ref - a.ref || cmp(a.donor, b.donor));
    const kept = admitted.slice(0, config.candidateMaxPerTarget);
    rejected.capped = admitted.length - kept.length;
    kept.forEach((c, i) => candidates.push({ ...c, rank: i + 1 }));
    for (const k of REJECTIONS) rejectedTotal[k] += rejected[k];
    targets.push({
      node: v,
      reasons,
      hasText: true,
      admitted: admitted.length,
      kept: kept.length,
      rejected,
    });
  }

  const targetsByReason = Object.fromEntries(
    TARGET_REASONS.map((r) => [r, targets.filter((t) => t.reasons.includes(r)).length]),
  ) as Record<TargetReason, number>;
  return {
    version: CANDIDATES_VERSION,
    refVersion: ref.version,
    refVariant: ref.variant,
    epsilon: config.epsilon,
    alpha: config.alpha,
    params: {
      candidateMaxPerTarget: config.candidateMaxPerTarget,
      candidateUtilityPatterns: config.candidateUtilityPatterns,
      candidateSectionBlocking: config.candidateSectionBlocking,
      candidateSiblingSections: config.candidateSiblingSections,
      candidateTopLevelIsSibling: config.candidateTopLevelIsSibling,
    },
    stats: {
      targets: targets.length,
      targetsByReason,
      targetsWithoutText: targets.filter((t) => !t.hasText).length,
      candidates: candidates.length,
      byAction: {
        "add-link": candidates.filter((c) => c.action === "add-link").length,
        "make-visible": candidates.filter((c) => c.action === "make-visible").length,
      },
      rejected: rejectedTotal,
    },
    targets,
    candidates,
  };
}

function sectionReason(relation: SectionRelation, donor: string, target: string): string {
  const name = (s: string) => (s === "" ? "top level" : `'${s}'`);
  switch (relation) {
    case "same":
      return `same section (${name(donor)})`;
    case "sibling":
      return `sibling sections (${name(donor)} ~ ${name(target)})`;
    case "top-level":
      return `${donor === "" ? "donor" : "target"} is a top-level page (${name(donor)} → ${name(target)})`;
    case "unblocked":
      return "section blocking is off";
  }
}

export interface PersistedCandidateList extends CandidateList {
  readonly artefact: ArtefactRow;
}

export interface LoadedCandidates {
  readonly list: CandidateList;
  /** The prominence the candidates were built from (existing links and their weights). */
  readonly prominence: RunProminence;
  readonly config: Readonly<LinkLensConfig>;
}

/**
 * Fix candidates for a run under `policyId`, with the run's stored config: targets from the
 * structural audit and the diagnosis, donors from the REF matrix (`variant`) and prominence,
 * all computed in memory. Nothing is written.
 */
export async function loadCandidates(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  variant: RefVariant = "weighted",
): Promise<LoadedCandidates> {
  const [{ model, config }, prominence, audit] = await Promise.all([
    loadTextModel(db, runId, policyId),
    loadProminence(db, runId, policyId),
    loadAudit(db, runId, policyId),
  ]);
  const ref = refMatrix(model, variant, config);
  const { diagnoses } = diagnose({ ref, prominence }, config);
  const list: CandidateList = {
    ...generateCandidates(
      {
        targets: candidateTargets(audit.issues, diagnoses),
        ref,
        edges: prominence.edges,
        diagnoses,
      },
      config,
    ),
    runId,
    policyVersion: ref.policyVersion,
  };
  return { list, prominence, config };
}

/** loadCandidates, appended as a `fix-candidates` artefact. */
export async function buildCandidatesRun(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
  variant: RefVariant = "weighted",
): Promise<PersistedCandidateList> {
  const { list } = await loadCandidates(db, runId, policyId, variant);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: list.policyVersion,
    kind: CANDIDATES_ARTEFACT,
    payload: list as unknown as Json,
  });
  return { ...list, artefact };
}
