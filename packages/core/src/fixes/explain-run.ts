import { loadAudit } from "../audit/structural.js";
import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import { insertArtefact, listArtefacts, listFetches, listPages } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import { diagnose } from "../diagnosis/diagnose.js";
import { loadProminence } from "../prominence/run.js";
import { refMatrix, type RefVariant } from "../semantic/ref.js";
import { buildTextModel } from "../text/model.js";
import { loadRunDocuments } from "../text/run.js";
import { SurfaceForms } from "../text/surface.js";
import { detachedImportance } from "../importance/importance.js";
import { importanceFor } from "../importance/run.js";
import { suggestAnchor, type AnchorResult } from "./anchor.js";
import { loadDonorEffort } from "./effort.js";
import {
  EXPLAIN_VERSION,
  EXPLANATIONS_ARTEFACT,
  explainAll,
  type TargetPage,
  type Explanations,
} from "./explain.js";
import { externalTargetWeights, RESCUE_ARTEFACT, type RescuedOrphan } from "./rescue.js";
import { FIX_RANKING_ARTEFACT, type FixRanking } from "./scoring.js";

export interface ExplanationSet extends Explanations {
  readonly version: string;
  readonly runId: number;
  readonly policyVersion: string;
  readonly refVariant: RefVariant;
  /** The artefacts explained (null when the run has none yet). */
  readonly sources: {
    readonly fixRankingArtefactId: number | null;
    readonly rescueArtefactId: number | null;
  };
  readonly counts: { readonly fixes: number; readonly rescues: number; readonly diagnoses: number };
}

export interface PersistedExplanationSet extends ExplanationSet {
  readonly artefact: ArtefactRow;
}

/**
 * Deterministic, template-based explanations for a run under `policyId`: every fix of the latest
 * `fix-ranking` artefact, every donor of the latest `orphan-rescue` artefact (either may be
 * absent) and every diagnosis, from the same evidence the pipeline used (REF with the ranking's
 * variant, prominence, audit issues, κ). Appended as an `explanations` artefact.
 */
export async function buildExplanations(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PersistedExplanationSet> {
  const policyVersion = POLICIES[policyId].version;
  const [rankingRow, rescueRow] = await Promise.all([
    listArtefacts(db, runId, { kind: FIX_RANKING_ARTEFACT, policyVersion }).then((r) => r.at(-1)),
    listArtefacts(db, runId, { kind: RESCUE_ARTEFACT, policyVersion }).then((r) => r.at(-1)),
  ]);
  const ranking = (rankingRow?.payload ?? null) as unknown as FixRanking | null;
  const rescue = (rescueRow?.payload ?? null) as unknown as { orphans: RescuedOrphan[] } | null;
  const refVariant = ranking?.sources.refVariant ?? "weighted";

  const [{ documents, config }, prominence, audit, effort, rescuePages, fetches] =
    await Promise.all([
      loadRunDocuments(db, runId, policyId),
      loadProminence(db, runId, policyId),
      loadAudit(db, runId, policyId),
      loadDonorEffort(db, runId, policyId),
      rescue === null ? [] : listPages(db, runId, "rescue"),
      rescue === null ? [] : listFetches(db, runId),
    ]);
  const model = buildTextModel({ runId, policyVersion, documents }, config);
  const ref = refMatrix(model, refVariant, config);
  const { diagnoses } = diagnose({ ref, prominence }, config);
  const index = new Map(ref.nodes.map((n, i) => [n, i]));
  const entries = new Map(ref.entries.map((e) => [`${e.source} ${e.target}`, e]));

  const matched = (u: string, v: string) =>
    entries.get(`${index.get(u)} ${index.get(v)}`)?.matched ?? [];

  // The words behind the stems, counted only for the terms that will be quoted.
  const quoted = new Set<string>();
  const want = (ts: readonly { term: string }[]) => {
    for (const t of ts.slice(0, config.explainTerms)) quoted.add(t.term);
  };
  for (const f of ranking?.fixes ?? []) want(matched(f.donor, f.target));
  for (const o of rescue?.orphans ?? []) for (const d of o.donors) want(d.matched);
  for (const d of diagnoses) want(d.matched);
  const surfaces = new SurfaceForms(documents, quoted, {
    minTokenLength: config.textMinTokenLength,
    maxNgram: config.textMaxNgram,
  });

  // Element-level REF: each donor paragraph against the target's Title field (a crawled
  // target's, or an orphan's rescue page weighted against the site model), for the anchor.
  const opts = { minTokenLength: config.textMinTokenLength, maxNgram: config.textMaxNgram };
  const docOf = new Map(documents.map((d) => [d.node, d]));
  const titles = new Map(
    model.documents.map((d) => [d.node, new Map(Object.entries(d.fields.title))]),
  );
  const rescueFetch = new Map<string, number>();
  for (const f of fetches) if (f.purpose === "rescue") rescueFetch.set(f.requestedUrl, f.id);
  const rescuePage = new Map(rescuePages.map((p) => [p.fetchId, p]));
  for (const o of rescue?.orphans ?? []) {
    const id = o.fetch === null ? undefined : rescueFetch.get(o.fetch.requestedUrl);
    const page = id === undefined ? undefined : rescuePage.get(id);
    if (page === undefined || titles.has(o.node)) continue;
    const title = [page.title, page.h1].filter((t): t is string => t !== null && t !== "");
    titles.set(o.node, externalTargetWeights({ title, body: [] }, model));
  }
  // The target's page type and importance (L12): a graph node's, else an orphan's detached one.
  const pageImportance = await importanceFor(db, runId, policyId);
  const targetPage = (v: string): TargetPage => {
    const n = pageImportance.nodes[v];
    if (n !== undefined) {
      return {
        type: n.type,
        rule: n.rule,
        importance: n.importance,
        // A fixed key order: the stored page-importance comes back from jsonb with its keys
        // reordered, and explanations must be byte-identical whether it was built or reused.
        components: {
          typePrior: n.components.typePrior,
          pagerank: n.components.pagerank,
          depth: n.components.depth,
          inboundBodyLinks: n.components.inboundBodyLinks,
        },
        depth: n.raw.depth,
        inboundBodyLinks: n.raw.inboundBodyLinks,
      };
    }
    const d = detachedImportance(v, config);
    return { ...d, depth: null, inboundBodyLinks: 0 };
  };
  const anchor = (u: string, v: string): AnchorResult | undefined => {
    const title = titles.get(v);
    const donor = docOf.get(u);
    if (title === undefined || donor === undefined) return undefined;
    return suggestAnchor(
      { paragraphs: donor.paragraphs ?? [], title, variant: refVariant, linked: donor.links },
      { ...config, ...opts },
    );
  };

  const explained = explainAll({
    fixes: ranking?.fixes ?? [],
    rescues: rescue?.orphans ?? [],
    diagnoses,
    issues: audit.issues,
    matched,
    surface: (term, nodes) => surfaces.of(term, nodes),
    anchor,
    targetPage,
    edges: prominence.edges,
    effort,
    alpha: config.alpha,
    epsilon: config.epsilon,
    explainTerms: config.explainTerms,
  });
  const set: ExplanationSet = {
    version: EXPLAIN_VERSION,
    runId,
    policyVersion,
    refVariant,
    sources: {
      fixRankingArtefactId: rankingRow?.id ?? null,
      rescueArtefactId: rescueRow?.id ?? null,
    },
    counts: {
      fixes: explained.fixes.length,
      rescues: explained.rescues.length,
      diagnoses: explained.diagnoses.length,
    },
    ...explained,
  };
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion,
    kind: EXPLANATIONS_ARTEFACT,
    payload: set as unknown as Json,
  });
  return { ...set, artefact };
}
