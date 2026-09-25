import type { discovery } from "@linklens/core";

type Channel = discovery.DiscoveryChannel;
const NON_LINK: readonly Channel[] = [
  "xml_sitemap",
  "robots_sitemap",
  "html_sitemap",
  "feed",
  "llms_txt",
];

export interface ChannelSubsetResult {
  /** The non-link channels used (the link graph is always used). */
  readonly channels: Channel[];
  /** Orphans these channels reveal (an orphan needs one of them). */
  readonly orphansFound: number;
  /** orphansFound / all orphans (1 when there are none). */
  readonly orphanRecall: number;
  /** Inventory pages known with the link graph plus these channels. */
  readonly pagesKnown: number;
}

export interface ChannelAblation {
  readonly orphans: number;
  readonly inventory: number;
  /** Every subset of the five non-link channels (32 rows, most channels first). */
  readonly subsets: ChannelSubsetResult[];
  /** Each channel on its own. */
  readonly single: ChannelSubsetResult[];
  /** All channels but one: what dropping that channel costs. */
  readonly leaveOneOut: (ChannelSubsetResult & {
    readonly removed: Channel;
    readonly orphansLost: number;
  })[];
}

/**
 * E2: which discovery channels are needed to find the orphans. Evaluates every subset of the
 * non-link channels on a run's reconciliation (the link graph is always on).
 */
export function channelAblation(rec: Pick<discovery.Reconciliation, "inventory">): ChannelAblation {
  const orphans = rec.inventory.filter((e) => e.orphan);
  const evaluate = (channels: Channel[]): ChannelSubsetResult => {
    const use = new Set<Channel>(channels);
    const found = orphans.filter((o) => o.channels.some((c) => use.has(c))).length;
    const known = rec.inventory.filter((e) =>
      e.channels.some((c) => c === "link_graph" || use.has(c)),
    ).length;
    return {
      channels,
      orphansFound: found,
      orphanRecall: orphans.length === 0 ? 1 : found / orphans.length,
      pagesKnown: known,
    };
  };
  const subsets: ChannelSubsetResult[] = [];
  for (let mask = (1 << NON_LINK.length) - 1; mask >= 0; mask--) {
    subsets.push(evaluate(NON_LINK.filter((_, i) => (mask & (1 << i)) !== 0)));
  }
  subsets.sort((a, b) => b.channels.length - a.channels.length || b.orphansFound - a.orphansFound);
  const all = evaluate([...NON_LINK]);
  return {
    orphans: orphans.length,
    inventory: rec.inventory.length,
    subsets,
    single: NON_LINK.map((c) => evaluate([c])),
    leaveOneOut: NON_LINK.map((removed) => {
      const r = evaluate(NON_LINK.filter((c) => c !== removed));
      return { ...r, removed, orphansLost: all.orphansFound - r.orphansFound };
    }),
  };
}
