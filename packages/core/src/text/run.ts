import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import { insertArtefact, listLinkObservations, listPages } from "../db/queries.js";
import type { ArtefactRow, Json, LinkObservationRow, PageRow, Queryable } from "../db/types.js";
import { buildLinkGraph } from "../graph/build.js";
import { loadRunGraphInputs } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import { buildTextModel, type RawDocument, type TextModel } from "./model.js";

export const TEXT_ARTEFACT = "text-representation";

/**
 * dom_region values whose links are body links (feed the Links field). Chrome regions (nav,
 * header, footer, aside, breadcrumb, pagination) are excluded.
 */
export const CONTENT_REGIONS: ReadonlySet<string> = new Set(["main", "body"]);

/**
 * A page's three fields:
 * - Title: `<title>` and `<h1>`.
 * - Links: anchor texts of the page's own outgoing links in a content region (`dom_region`
 *   main/body), in document order. Anchors pointing *to* the page are never used.
 * - Body: the stored main-content text. The extractor already stripped nav/header/footer/aside/
 *   breadcrumb/pagination from it, with the same region classifier that writes `dom_region`.
 */
export function rawDocument(
  node: string,
  page: Pick<PageRow, "fetchId" | "url" | "title" | "h1" | "bodyText">,
  links: readonly Pick<LinkObservationRow, "anchorText" | "domRegion" | "positionIndex">[],
): RawDocument {
  const present = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null && x !== "");
  return {
    node,
    fetchId: page.fetchId,
    url: page.url,
    title: present([page.title, page.h1]),
    links: present(
      [...links]
        .filter((l) => l.domRegion !== null && CONTENT_REGIONS.has(l.domRegion))
        .sort((a, b) => a.positionIndex - b.positionIndex)
        .map((l) => l.anchorText),
    ),
    body: present([page.bodyText]),
  };
}

export interface PersistedTextModel extends TextModel {
  readonly artefact: ArtefactRow;
}

/**
 * Build the text representation of a run under `policyId` and append it as a
 * `text-representation` artefact. Documents are the policy's crawled nodes; a node that merges
 * several pages is represented by the same page as in the link graph (the earliest fetch).
 * Uses the run's stored config.
 */
export async function buildTextRun(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PersistedTextModel> {
  const { observations, context, config } = await loadRunGraphInputs(db, runId);
  const policy = POLICIES[policyId];
  const { graph } = buildLinkGraph({
    seedUrl: observations.seedUrl,
    pages: observations.pages,
    links: observations.links,
    isInternal: makeInternalTest(observations.seedUrl, config.includeSubdomains),
    canonicalise: (url) => policy.canonicalise(url, context),
  });

  const [pages, links] = await Promise.all([listPages(db, runId), listLinkObservations(db, runId)]);
  const pageByFetch = new Map(pages.map((p) => [p.fetchId, p]));
  const linksByFetch = new Map<number, LinkObservationRow[]>();
  for (const l of links) {
    const ls = linksByFetch.get(l.sourceFetchId);
    if (ls === undefined) linksByFetch.set(l.sourceFetchId, [l]);
    else ls.push(l);
  }

  const documents: RawDocument[] = [];
  graph.forEachNode((node, a) => {
    const page =
      a.representativeFetchId === null ? undefined : pageByFetch.get(a.representativeFetchId);
    if (page !== undefined) {
      documents.push(rawDocument(node, page, linksByFetch.get(page.fetchId) ?? []));
    }
  });

  const model = buildTextModel({ runId, policyVersion: policy.version, documents }, config);
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: policy.version,
    kind: TEXT_ARTEFACT,
    payload: model as unknown as Json,
  });
  return { ...model, artefact };
}
