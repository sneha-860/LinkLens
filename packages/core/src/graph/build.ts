import { MultiDirectedGraph } from "graphology";

/** A crawled HTML page: the source document of link observations. */
export interface PageInput {
  readonly fetchId: number;
  /** Page URL (the fetch's final URL). */
  readonly url: string;
}

/** One raw link observation (a link_observations row). */
export interface LinkInput {
  readonly id: number;
  readonly sourceFetchId: number;
  readonly resolvedUrl: string;
  readonly domRegion: string | null;
  readonly anchorText: string | null;
  readonly templateSignature: string | null;
  readonly rel: string | null;
}

/** Set on every node by deriveGraphFromObservations (absent on a freshly built graph). */
export interface NodeAttributes extends Partial<NodeMetrics> {
  /** Some crawled HTML page maps to this node. */
  crawled: boolean;
  /** How many crawled pages the policy merged into this node. */
  pages: number;
  /** The page whose links represent this node (the earliest fetch), or null if not crawled. */
  representativeFetchId: number | null;
  /** Links from this node to itself, dropped from the graph but counted. */
  selfLoops: number;
}

/** Metrics attached to every node of the derived graph. */
export interface NodeMetrics {
  pagerank: number;
  /** BFS click depth from the seed/homepage; null if unreachable. */
  depth: number | null;
  reachable: boolean;
  /** Link observations in / out (parallel edges counted; self-loops excluded). */
  inDegree: number;
  outDegree: number;
  /** Distinct neighbouring nodes in / out. */
  inNeighbours: number;
  outNeighbours: number;
  sccId: number;
  inLargestScc: boolean;
  /** Directed betweenness (ordered pairs; estimated if sampled). */
  betweenness: number;
  /** betweenness / ((N−1)(N−2)), 0 when N < 3. */
  betweennessNormalized: number;
}

export interface EdgeAttributes {
  observationId: number;
  domRegion: string | null;
  anchorText: string | null;
  templateSignature: string | null;
  rel: string | null;
}

export type LinkGraph = MultiDirectedGraph<NodeAttributes, EdgeAttributes>;

export interface BuiltGraph {
  readonly graph: LinkGraph;
  readonly seedNode: string;
  readonly stats: {
    readonly selfLoops: number;
    readonly externalLinks: number;
    /** Links from pages that were merged into another page's node (not the representative). */
    readonly duplicatePageLinks: number;
  };
}

export interface BuildInput {
  readonly seedUrl: string;
  readonly pages: readonly PageInput[];
  readonly links: readonly LinkInput[];
  /** Is this raw URL part of the site (see makeInternalTest)? */
  readonly isInternal: (url: string) => boolean;
  /** The policy, already bound to its context: raw URL → node id. */
  readonly canonicalise: (url: string) => string;
}

/**
 * Directed multigraph over policy nodes. Nodes: the seed, every crawled page, every internal
 * link target. Edges: one per link observation (key `obs:<id>`), from the source page's node to
 * the target's node, carrying the observation's attributes. Self-loops are dropped but counted
 * per node. External and non-http targets are left out.
 *
 * When a policy merges several crawled pages into one node, that node's out-links come from one
 * representative page (the earliest fetch) so the same template links are not counted twice.
 * Nodes and edges are inserted in sorted order, so the graph is identical for identical input.
 */
export function buildLinkGraph(input: BuildInput): BuiltGraph {
  const node = new Map<string, string>(); // raw URL → node id (memoised)
  const nodeOf = (url: string) => {
    let id = node.get(url);
    if (id === undefined) {
      id = input.canonicalise(url);
      node.set(url, id);
    }
    return id;
  };

  const attrs = new Map<string, NodeAttributes>();
  const ensure = (id: string): NodeAttributes => {
    let a = attrs.get(id);
    if (a === undefined) {
      a = { crawled: false, pages: 0, representativeFetchId: null, selfLoops: 0 };
      attrs.set(id, a);
    }
    return a;
  };

  const seedNode = nodeOf(input.seedUrl);
  ensure(seedNode);

  const pageNode = new Map<number, string>(); // fetchId → node
  for (const page of [...input.pages].sort((a, b) => a.fetchId - b.fetchId)) {
    const id = nodeOf(page.url);
    const a = ensure(id);
    a.crawled = true;
    a.pages += 1;
    a.representativeFetchId ??= page.fetchId;
    pageNode.set(page.fetchId, id);
  }

  let selfLoops = 0;
  let externalLinks = 0;
  let duplicatePageLinks = 0;
  const edges: { key: string; source: string; target: string; attributes: EdgeAttributes }[] = [];
  for (const link of [...input.links].sort((a, b) => a.id - b.id)) {
    const source = pageNode.get(link.sourceFetchId);
    if (source === undefined) continue; // source page not in this run's pages
    if (attrs.get(source)?.representativeFetchId !== link.sourceFetchId) {
      duplicatePageLinks += 1;
      continue;
    }
    if (!input.isInternal(link.resolvedUrl)) {
      externalLinks += 1;
      continue;
    }
    const target = nodeOf(link.resolvedUrl);
    ensure(target);
    if (target === source) {
      selfLoops += 1;
      ensure(source).selfLoops += 1;
      continue;
    }
    edges.push({
      key: `obs:${link.id}`,
      source,
      target,
      attributes: {
        observationId: link.id,
        domRegion: link.domRegion,
        anchorText: link.anchorText,
        templateSignature: link.templateSignature,
        rel: link.rel,
      },
    });
  }

  const graph: LinkGraph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes>({
    allowSelfLoops: false,
  });
  for (const id of [...attrs.keys()].sort()) graph.addNode(id, attrs.get(id));
  for (const e of edges) graph.addEdgeWithKey(e.key, e.source, e.target, e.attributes);
  return { graph, seedNode, stats: { selfLoops, externalLinks, duplicatePageLinks } };
}
