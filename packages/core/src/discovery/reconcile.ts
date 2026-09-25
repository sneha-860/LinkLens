import { POLICIES, type PolicyId } from "../canonicalise/index.js";
import { insertArtefact, listDiscoveryObservations } from "../db/queries.js";
import type { ArtefactRow, Json, Queryable } from "../db/types.js";
import { deriveGraphFromObservations, loadRunGraphInputs } from "../graph/derive.js";
import { makeInternalTest } from "../graph/scope.js";
import { DISCOVERY_CHANNELS, type DiscoveryChannel } from "./channels.js";

export const DISCOVERY_ARTEFACT = "discovery-reconciliation";

export interface ObservationInput {
  readonly channel: DiscoveryChannel;
  readonly url: string;
  readonly sourceDocument: string | null;
  readonly detail: { readonly [key: string]: Json };
}

export interface InventoryEntry {
  /** Canonical node id under the policy. */
  readonly node: string;
  /** Channels that found it, in DISCOVERY_CHANNELS order. */
  readonly channels: DiscoveryChannel[];
  /** Per channel: distinct documents it was found in (sorted; null = the crawl seed). */
  readonly sources: Partial<Record<DiscoveryChannel, (string | null)[]>>;
  /** Raw URLs observed that map to this node (sorted, distinct). */
  readonly urls: string[];
  /** Reachable from the seed in the policy's link graph. */
  readonly reachable: boolean;
  readonly depth: number | null;
  /** Found by some non-link channel but not reachable in the link graph. */
  readonly orphan: boolean;
}

export interface ChannelStats {
  /** Inventory nodes this channel found. */
  readonly total: number;
  /** Nodes only this channel found (marginal yield). */
  readonly exclusive: number;
  /** Orphans this channel found. */
  readonly orphans: number;
}

export interface Reconciliation {
  readonly runId: number;
  readonly policyVersion: string;
  readonly inventory: InventoryEntry[];
  readonly orphans: string[];
  readonly channels: Record<DiscoveryChannel, ChannelStats>;
  /** Observations left out: outside the site, or robots.txt directives (sitemap files, not pages). */
  readonly skipped: { readonly external: number; readonly directives: number };
}

export interface ReconcileInput {
  readonly runId: number;
  readonly policyVersion: string;
  readonly observations: readonly ObservationInput[];
  readonly isInternal: (url: string) => boolean;
  /** Raw URL → node id under the policy. */
  readonly canonicalise: (url: string) => string;
  /** Reachability and depth of nodes in the policy's link graph (absent = not in the graph). */
  readonly graph: ReadonlyMap<string, { reachable: boolean; depth: number | null }>;
}

const sorted = <T extends string | null>(xs: Iterable<T>) =>
  [...new Set(xs)].sort((a, b) => (a ?? "").localeCompare(b ?? "") || (a === null ? -1 : 1));

/**
 * Pure reconciliation:
 *  - inventory = union over channels of the (internal, non-directive) observed URLs, as nodes;
 *  - for each node: which channels found it, from which documents, and the raw URLs;
 *  - orphan = found by any non-link channel and not reachable from the seed in the link graph;
 *  - per channel: total, exclusive (marginal yield: nodes no other channel found) and orphans.
 */
export function reconcile(input: ReconcileInput): Reconciliation {
  const byNode = new Map<
    string,
    {
      channels: Set<DiscoveryChannel>;
      sources: Map<DiscoveryChannel, Set<string | null>>;
      urls: Set<string>;
    }
  >();
  let external = 0;
  let directives = 0;
  for (const o of input.observations) {
    if (o.detail["kind"] === "directive") {
      directives += 1;
      continue;
    }
    if (!input.isInternal(o.url)) {
      external += 1;
      continue;
    }
    const node = input.canonicalise(o.url);
    let e = byNode.get(node);
    if (e === undefined) {
      e = { channels: new Set(), sources: new Map(), urls: new Set() };
      byNode.set(node, e);
    }
    e.channels.add(o.channel);
    e.urls.add(o.url);
    const src = e.sources.get(o.channel) ?? new Set<string | null>();
    src.add(o.sourceDocument);
    e.sources.set(o.channel, src);
  }

  const inventory: InventoryEntry[] = [...byNode.keys()].sort().map((node) => {
    const e = byNode.get(node) as NonNullable<ReturnType<typeof byNode.get>>;
    const g = input.graph.get(node);
    const reachable = g?.reachable === true;
    const channels = DISCOVERY_CHANNELS.filter((c) => e.channels.has(c));
    return {
      node,
      channels,
      sources: Object.fromEntries(channels.map((c) => [c, sorted(e.sources.get(c) ?? [])])),
      urls: sorted(e.urls),
      reachable,
      depth: g?.depth ?? null,
      orphan: !reachable && channels.some((c) => c !== "link_graph"),
    };
  });

  const channels = Object.fromEntries(
    DISCOVERY_CHANNELS.map((c) => {
      const found = inventory.filter((e) => e.channels.includes(c));
      return [
        c,
        {
          total: found.length,
          exclusive: found.filter((e) => e.channels.length === 1).length,
          orphans: found.filter((e) => e.orphan).length,
        },
      ];
    }),
  ) as Record<DiscoveryChannel, ChannelStats>;

  return {
    runId: input.runId,
    policyVersion: input.policyVersion,
    inventory,
    orphans: inventory.filter((e) => e.orphan).map((e) => e.node),
    channels,
    skipped: { external, directives },
  };
}

export interface PersistedReconciliation extends Reconciliation {
  readonly artefact: ArtefactRow;
}

/**
 * Reconcile a run's discovery channels under `policyId` and persist the result as a
 * `discovery-reconciliation` artefact (run id + policy version). Reachability comes from the
 * policy's link graph, derived from the crawl with the run's stored config.
 */
export async function reconcileDiscovery(
  db: Queryable,
  runId: number,
  policyId: PolicyId,
): Promise<PersistedReconciliation> {
  const { observations, context, config } = await loadRunGraphInputs(db, runId);
  const policy = POLICIES[policyId];
  const { graph } = deriveGraphFromObservations(observations, policyId, context, config);
  const reach = new Map<string, { reachable: boolean; depth: number | null }>();
  graph.forEachNode((node, a) =>
    reach.set(node, { reachable: a.reachable === true, depth: a.depth ?? null }),
  );

  const rows = await listDiscoveryObservations(db, runId);
  const result = reconcile({
    runId,
    policyVersion: policy.version,
    observations: rows,
    isInternal: makeInternalTest(observations.seedUrl, config.includeSubdomains),
    canonicalise: (url) => policy.canonicalise(url, context),
    graph: reach,
  });
  const artefact = await insertArtefact(db, {
    runId,
    policyVersion: policy.version,
    kind: DISCOVERY_ARTEFACT,
    payload: result as unknown as Json,
  });
  return { ...result, artefact };
}
