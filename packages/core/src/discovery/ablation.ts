import { DISCOVERY_CHANNELS, type DiscoveryChannel } from "./channels.js";
import { reconcile, type ReconcileInput, type Reconciliation } from "./reconcile.js";

/** One channel removed: the reconciliation recomputed without its observations (E2). */
export interface ChannelRemoval {
  readonly channel: DiscoveryChannel;
  /** Inventory nodes the channel found, and those no other channel found (lost without it). */
  readonly pagesTotal: number;
  readonly pagesExclusive: number;
  /** Orphans the channel reveals, and those lost without it (its marginal orphan yield). */
  readonly orphansTotal: number;
  readonly orphansExclusive: number;
  /** orphansExclusive / all orphans: the share detected only by this channel (null: none). */
  readonly orphansExclusiveShare: number | null;
  /** The recomputed reconciliation's size. */
  readonly inventoryWithout: number;
  readonly orphansWithout: number;
  /** The orphans lost (sorted node ids), for provenance. */
  readonly lostOrphans: string[];
}

export interface ChannelLeaveOneOut {
  readonly runId: number;
  readonly policyVersion: string;
  readonly inventory: number;
  readonly orphans: number;
  /**
   * Orphans by the non-link channels that reveal them: exactly one (per channel) or several.
   * The counts add up to `orphans`.
   */
  readonly orphansBy: {
    readonly only: Record<DiscoveryChannel, number>;
    readonly several: number;
  };
  /** One per channel, in DISCOVERY_CHANNELS order. */
  readonly removals: ChannelRemoval[];
}

/**
 * Pure (E2): remove each of the six channels in turn and reconcile again from the remaining
 * observations. Reachability comes from the crawl's link graph, which no channel changes, so
 * removing the link graph channel loses pages but never an orphan (an orphan is revealed by a
 * non-link channel), and removing a channel never creates one.
 */
export function leaveOneChannelOut(input: ReconcileInput): ChannelLeaveOneOut {
  const full = reconcile(input);
  const orphans = new Set(full.orphans);
  const removals = DISCOVERY_CHANNELS.map((channel): ChannelRemoval => {
    const without: Reconciliation = reconcile({
      ...input,
      observations: input.observations.filter((o) => o.channel !== channel),
    });
    const kept = new Set(without.orphans);
    const lostOrphans = [...orphans].filter((o) => !kept.has(o)).sort();
    const gained = without.orphans.filter((o) => !orphans.has(o));
    if (gained.length > 0) {
      throw new Error(`removing ${channel} created orphans (${gained.join(", ")}): not monotone`);
    }
    const stats = full.channels[channel];
    return {
      channel,
      pagesTotal: stats.total,
      pagesExclusive: full.inventory.length - without.inventory.length,
      orphansTotal: stats.orphans,
      orphansExclusive: lostOrphans.length,
      orphansExclusiveShare: orphans.size === 0 ? null : lostOrphans.length / orphans.size,
      inventoryWithout: without.inventory.length,
      orphansWithout: without.orphans.length,
      lostOrphans,
    };
  });

  const only = Object.fromEntries(DISCOVERY_CHANNELS.map((c) => [c, 0])) as Record<
    DiscoveryChannel,
    number
  >;
  let several = 0;
  for (const e of full.inventory) {
    if (!e.orphan) continue;
    const revealing = e.channels.filter((c) => c !== "link_graph");
    if (revealing.length === 1) only[revealing[0] as DiscoveryChannel] += 1;
    else several += 1;
  }

  return {
    runId: full.runId,
    policyVersion: full.policyVersion,
    inventory: full.inventory.length,
    orphans: orphans.size,
    orphansBy: { only, several },
    removals,
  };
}
