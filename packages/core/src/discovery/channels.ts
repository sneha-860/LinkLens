/**
 * Reconciliation of the six discovery channels (link graph, XML sitemap, robots.txt Sitemap,
 * HTML sitemap, RSS/Atom, llms.txt) with per-channel provenance; orphan detection.
 * Reconciliation is in reconcile.ts.
 */

/** The six discovery channels. Values match the `discovery_observations.channel` CHECK constraint. */
export const DISCOVERY_CHANNELS = [
  "link_graph",
  "xml_sitemap",
  "robots_sitemap",
  "html_sitemap",
  "feed",
  "llms_txt",
] as const;

export type DiscoveryChannel = (typeof DISCOVERY_CHANNELS)[number];
