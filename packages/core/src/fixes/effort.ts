import type { PolicyId } from "../canonicalise/index.js";
import type { Queryable } from "../db/types.js";
import { loadPageLinks } from "../prominence/run.js";
import { regionClass, type PageLinks } from "../prominence/weights.js";

/** One link block (template signature) of a donor's body, and how many pages carry it. */
export interface TemplateUse {
  readonly signature: string;
  /** Pages of the site whose links include this signature (in any region). */
  readonly pages: number;
}

/** Editing effort of a donor page. */
export interface DonorEffort {
  readonly node: string;
  /**
   * κ(u): distinct template signatures among the donor's body-region link blocks, at least 1.
   * A page whose body links sit in one block costs 1; each further block adds 1.
   */
  readonly kappa: number;
  /**
   * templateReach(u): the most pages that share one of the donor's body blocks (1 when it has
   * none, i.e. only the page itself). A block on many pages is a template: editing it there
   * changes them all.
   */
  readonly templateReach: number;
  /** The donor's body blocks, widest first (ties by signature). */
  readonly templates: TemplateUse[];
  /** Body-region link observations on the donor's page (main, body or no region). */
  readonly bodyLinks: number;
}

/** For each template signature, the number of pages whose links include it. */
export function templatePages(pages: readonly PageLinks[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const p of pages) {
    const sigs = new Set<string>();
    for (const l of p.links) if (l.templateSignature !== null) sigs.add(l.templateSignature);
    for (const s of sigs) count.set(s, (count.get(s) ?? 0) + 1);
  }
  return count;
}

/**
 * κ(u) and templateReach(u) of one page. Only body-region links count toward κ (main, body, or
 * a missing region; the same classes as prominence); links without a signature are ignored.
 */
export function donorEffort(page: PageLinks, reach: ReadonlyMap<string, number>): DonorEffort {
  const body = page.links.filter((l) => regionClass(l.domRegion) === "body");
  const sigs = new Set<string>();
  for (const l of body) if (l.templateSignature !== null) sigs.add(l.templateSignature);
  const templates = [...sigs]
    .map((signature) => ({ signature, pages: reach.get(signature) ?? 1 }))
    .sort((a, b) => b.pages - a.pages || (a.signature < b.signature ? -1 : 1));
  return {
    node: page.node,
    kappa: Math.max(1, sigs.size),
    templateReach: templates[0]?.pages ?? 1,
    templates,
    bodyLinks: body.length,
  };
}

/** κ and templateReach for every page, keyed by node. */
export function effortByNode(pages: readonly PageLinks[]): Map<string, DonorEffort> {
  const reach = templatePages(pages);
  return new Map(pages.map((p) => [p.node, donorEffort(p, reach)]));
}

/** κ and templateReach of every crawled node of a run under `policyId`. Nothing is written. */
export async function loadDonorEffort(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<Map<string, DonorEffort>> {
  const { pages } = await loadPageLinks(db, runId, policyId);
  return effortByNode(pages);
}
