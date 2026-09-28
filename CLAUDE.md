# LinkLens — Internal Link Auditor

This file is the authoritative project spec. Read it before changing anything.

## Overview

LinkLens crawls a public site (500-page cap, robots.txt-compliant per RFC 9309), stores raw link
observations **append-only**, and derives graphs under six versioned canonicalisation policies
(**P0–P5**).

## Discovery channels & orphans

LinkLens detects orphans by reconciling six discovery channels, with **per-channel provenance**:

1. Link graph
2. XML sitemap
3. robots.txt `Sitemap:` directives
4. HTML sitemap
5. RSS/Atom
6. llms.txt

## Graph metrics

PageRank, BFS depth, strongly connected components (SCC), betweenness, and in/out degrees.

## Semantic layer

Adapted from patent **US 11,586,824 B2** (Belezko & McGoey, 2023).

- Directional containment, weighted by the target's TF-IDF weights (reduces the patent's
  short-target bias): `REF(A,B) = Σ_{t ∈ S_A ∩ S_B} w_B(t) / Σ_{t ∈ S_B} w_B(t)`. The patent's
  unweighted `|S_A ∩ S_B| / |S_B|` is kept as a variant for the σ ablation (E7).
  - `S_A = Links(A) ∪ Body(A)`
  - `S_B = Title(B) ∪ Body(B)`
- Computed over **field-aware, site-specific TF-IDF token sets**, with an **ε cutoff** and
  **per-node normalisation**.
- The patent's session-based popularity is replaced by a **structural link-prominence proxy**.
  Always call it **"prominence"**, never "popularity" (in code, docs, UI and variable names).

### Four-case diagnosis

For each pair with REF > ε or a link, with threshold α (`config.alpha`):

| Label | Meaning              | Rule               | Recommendation                            |
| ----- | -------------------- | ------------------ | ----------------------------------------- |
| v4    | missing              | ρ > α, no link     | add link                                  |
| v3    | buried               | ρ > α, link, ω < α | make more visible                         |
| v2    | good                 | ρ > α, ω ≥ α       | none                                      |
| v1    | misleading/low-value | ρ ≤ α, ω ≥ α       | flag for review/removal (never simulated) |

## Fix simulation & ranking

- A fix is simulated by adding an edge to a **copy** of the graph and recomputing PageRank.
- Fixes are ranked by `S(u→v) = ΔPR_v × σ_hybrid(u,v) / κ(u)`
  - `σ_hybrid(u,v) = cosine(u,v)` if `REF > ε`, else `0`
  - `κ(u)` = editing effort
- Every fix carries a **rule-based explanation**.
- Orphans get **"rescue" donors**.

## Evaluation

| ID  | Experiment                   |
| --- | ---------------------------- |
| E1  | Canonicalisation sensitivity |
| E2  | Channel ablation             |
| E3  | Fixes vs baselines           |
| E4  | 14-day re-crawl stability    |
| E5  | Screaming Frog calibration   |
| E6  | Hide-and-recover             |
| E7  | σ ablation                   |
| E8  | Human rating (optional)      |

## Principles (non-negotiable)

- Raw data is **never normalised on write**.
- Every derived artefact stores the **policy version and run id**.
- **All thresholds live in one config file**: `packages/core/src/config.ts`. No magic numbers elsewhere.
- **Determinism**: fixed seeds (`randomSeed` in config).
- **Every module has unit tests.**

## Repo conventions

- pnpm workspaces; TypeScript strict; ESLint (flat config) + Prettier; Vitest.
- `packages/core`: pure algorithms, **no I/O** (no `fs`, `http`, `net`, `fetch`, `pg`). ESLint enforces this.
  - `core/src/db`: row types + typed query helpers for the schema. Helpers take an injected
    `Queryable`; core never imports a driver or opens a connection.
- `packages/db`: `pg` pool, `Queryable` adapter, SQL migrations (node-pg-migrate, `migrations/*.sql`),
  and integration tests against the docker-compose Postgres.
- `packages/crawler`: fetching, robots.txt, raw observation storage.
- `packages/embeddings`: sentence embeddings (transformers.js) in a worker thread, with a disk cache.
- `packages/counterfactual`: fix simulation in parallel worker threads (pure engine in core).
- `packages/api`: Express HTTP API and the pipeline runner.
- `packages/web`: React + Vite UI.
- `packages/eval`: experiments E1–E8.
- `analysis/`: Python statistics (not part of the pnpm workspace).

### Crawler politeness (packages/crawler)

- robots.txt (`src/robots/`) follows RFC 9309:
  - The crawler's product token (from `config.userAgent`) is matched case-insensitively. Every
    group naming it is merged; if none does, every `*` group is merged instead.
  - Longest match wins; on a tie, Allow wins.
  - `*` and a trailing `$` are wildcards; `%2A` and `%24` are the literal characters. Percent-encoding
    is normalised before comparison, never on storage.
  - A 4xx response, or more than `robotsMaxRedirects` redirects, means allow all. A 5xx, network
    error or timeout means disallow all. `/robots.txt` itself is always allowed.
  - 429 follows the RFC (allow all) unless `robotsTreat429AsUnreachable` is set.
  - Unreachable for `robotsUnreachableGraceDays` (30), judged from earlier runs' robots.txt fetches:
    allow all (§2.3.1.4).
  - Cached per origin for at most `robotsCacheTtlMs` (24 h, §2.4). A failed load is never cached.
  - Every robots.txt request, each redirect hop included, waits on the per-host throttle
    (`fetchRobots` hooks `beforeRequest` / `afterDispatch`).
  - `Sitemap:` lines are collected raw with line numbers; they are a discovery channel.
- Politeness: consecutive dispatches to a host are at least `max(config.crawlDelayMs, robots Crawl-delay)`
  apart, in real time, across every process and run. `RedisHostThrottle` has two phases:
  `acquire()` takes the host's single slot, and `dispatched()` records the time after the request
  is sent. The robots.txt Crawl-delay is stored per host (not per run). The in-process
  `HostThrottle` is kept for single-process/offline use.
- A host whose Crawl-delay exceeds `maxCrawlDelayMs` is not crawled at all. Its fetches are recorded
  as blocked. We never go faster than a site asks.
- `createRun` refuses a User-Agent without a product token, a version and a `(+https://…)` contact.

### Crawl orchestrator (packages/crawler/src/orchestrator.ts)

- BullMQ on Redis: one queue per run (`crawl-run-<id>`). Job priority is depth + 1, which gives BFS
  order. `crawlConcurrency = 1` (the default) keeps the order deterministic.
- Frontier state in Redis: a seen-set plus an admitted counter, updated by one atomic Lua script.
  At most `pageCap` URLs are admitted.
- Dedupe key = the link's `resolved_url` (RFC 3986, see below) with the fragment dropped (fragments
  are never sent to the server). Nothing else is normalised: case, ports, percent-encoding, trailing
  slashes, queries and index files stay as they are. WHATWG `URL` is used only to test scope and to
  send the request. Links it cannot parse are recorded but not fetched.
- Before every request, including each redirect hop: check scope, check robots.txt, wait on the
  per-host bucket. Redirects are followed manually and each hop is stored as
  `{url, statusCode, location}`.
- Every attempt is a `fetches` row, numbered by `attempt`. That includes robots.txt fetches,
  retries and robots-blocked URLs (the blocked ones have `status_code = null` and an error).
  Downstream code reads `final_fetches` / `listFinalFetches` for the outcome of each URL.
- Only 2xx HTML is parsed, into `pages` and `link_observations`. Its raw bytes go into `fetch_bodies`
  (when `storeRawHtml` is on) with a SHA-256, so extraction can be re-run offline. A redirect target
  already in the frontier is not re-extracted.
- nofollow: `followNofollow` (default true) enqueues rel=nofollow links and links on meta-nofollow
  pages. Either way they are always recorded. `pages.nofollow` flags meta-robots nofollow/none.

### HTML extraction (packages/crawler/src/extract.ts, src/html/)

- Cheerio (parse5, so parsing matches browsers). One `link_observations` row per `<a href>` in
  document order (`position_index`). `raw_href` is exactly as written.
- `resolved_url`: RFC 3986 §5.2 resolution against the document base (the first `<base href>`,
  itself resolved against the page URL, else the page URL), and **nothing else**. The only
  preprocessing is the HTML-mandated strip of leading/trailing ASCII whitespace. The fragment is kept.
  Never use WHATWG `URL` to produce it (that lower-cases hosts, drops ports, re-encodes).
- `anchor_text`: link text including `img alt`; `aria-label` if there is no text.
- `dom_region` (`src/html/region.ts`) is one of breadcrumb, pagination, nav, header, footer, aside,
  main or body (the default). Evidence per element: breadcrumb/pagination signals first
  (aria-label, class/id, schema.org BreadcrumbList, rel=next/prev on the link), then semantic
  tags/ARIA roles, then class/id words. `<header>`/`<footer>` inside sectioning content are not
  chrome. The nearest region wins, except that a nav inside a footer or aside reports the outer one.
- `dom_path`: short CSS-like path from the nearest ancestor with an id (`tag#id`), or from `<body>`.
- `template_signature`: null for a link directly under `<body>` (no block, no template); otherwise
  16 hex chars of SHA-1 over the ancestor chain (tag, digit-free id,
  structural classes). Positions, digits and state classes (active/current/is-*) are dropped, so the
  same block matches across pages.
- `body_text` and `paragraphs` (`<p>` and `<li>`) come from `<main>`/`[role=main]`, else `<body>`,
  with nav/header/footer/aside/breadcrumb/pagination stripped. `body_text` has one line per block
  element (the tokeniser treats line breaks as phrase breaks).
- `base_href`: the document base a `<base href>` sets (resolved), else null. P5 resolves
  rel=canonical against it.
- 5xx, network errors and timeouts are retried up to `fetchMaxRetries` times with exponential
  backoff. 4xx is never retried.
- `pageCap` counts every admitted URL, whatever its outcome.
- `cancel()` aborts the in-flight request, closes the worker, obliterates the queue, clears the
  frontier keys and sets the run to `cancelled`.
- `detach()` / `CrawlOrchestrator.shutdown()` stop the worker but keep the Redis state; the run stays
  `running`. `resume(runId)` continues it, and marks it `failed` if the Redis state is gone. Jobs
  in flight in a crashed process are re-queued by BullMQ's stalled-job check once their lock
  (`crawlJobLockMs`, also the stalled-check interval) expires; this is tested with a simulated
  crash.
- Events: `progress` (pagesFetched, a Redis counter that survives restarts; queueSize, admitted,
  url, depth, outcome), `done`, `error`.

### Canonicalisation policies (packages/core/src/canonicalise)

Pure `(url, context) => nodeId`; the node id is the canonical URL string. Each policy adds one step
to the previous one, so each is at least as coarse as the last (this is tested). Each exports a
version (`P3_VERSION = "P3@1.0.0"`), which goes into `artefacts.policy_version`. **Bump the version
whenever the output can change.**

| Policy | Adds                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0     | RFC 3986 §6.2.2/6.2.3: lower-case scheme and host; percent-encoding normalisation (decode unreserved, upper-case hex, UTF-8-encode non-URI chars); remove dot-segments; drop default/empty port; empty http path → `/`         |
| P1     | drop the fragment; strip trailing slashes (not the root)                                                                                                                                                                       |
| P2     | drop tracking params (`utm_*`, `mc_*`, `gclid`, `fbclid`, `ref`; names case-insensitive) and empty params; stable-sort the rest by name; drop an empty query                                                                   |
| P3     | drop the query; http/https and `www.`/bare are one host (node form `https://`, no `www.`)                                                                                                                                      |
| P4     | follow recorded redirects (P3 node graph); a loop maps to its smallest node                                                                                                                                                    |
| P5     | follow rel=canonical (RFC 6596) hop by hop while it is same-site (P3 host) and the target was fetched 2xx. A cycle stops at its entry node; a chain longer than `canonicalMaxHops` is not trusted (the page keeps its P4 node) |

- `buildCanonicalContext(observationsFromRows(fetches, pages), { maxCanonicalHops })` projects
  redirect edges onto P3 nodes and canonical edges onto P4 nodes. With conflicting observations,
  the most frequent wins and ties go to the smallest target (deterministic).
- RFC 3986 parsing, resolution and normalisation primitives live in `core/src/url/rfc3986.ts`
  (exported as `rfc3986`). The crawler uses them for `resolved_url`.

### Link graph and metrics (packages/core/src/graph)

- `deriveGraph(db, runId, policyId)` loads the run's pages, link observations and fetches, and builds
  the P4/P5 context. It derives the graph with the **run's stored config** and appends a
  `link-graph` artefact whose payload is graphology's `export()` and whose `policy_version` is the
  policy's version. The pure core is `deriveGraphFromObservations`.
- Graph: graphology `MultiDirectedGraph`.
  - Nodes: the seed, every crawled page and every internal link target (crawler scope rule), in
    sorted order.
  - Edges: one per link observation (`obs:<id>`), carrying observationId, domRegion, anchorText,
    templateSignature and rel.
  - Self-loops are dropped but counted per node. External and non-http links are left out.
  - When a policy merges pages, a node's out-links come from its earliest-fetched page only
    (`representativeFetchId`); the rest are counted as `duplicatePageLinks`.
- Metrics (node attributes; algorithms in `metrics.ts`, visited in a fixed order):
  - PageRank: weighted by edge multiplicity, `pagerankDamping`. Dangling mass is spread uniformly.
    Power iteration until the L1 change is < `pagerankTolerance` or `pagerankMaxIterations`
    (`converged` is reported).
  - BFS `depth` from the seed (null if unreachable), `reachable`.
  - `inDegree`/`outDegree` count observations; `inNeighbours`/`outNeighbours` count distinct nodes.
  - `sccId` (iterative Tarjan; ids ordered by smallest member), `inLargestScc` (ties go to the
    component with the smallest member).
  - Betweenness: Brandes, unweighted, directed. Exact up to `betweennessExactMaxNodes` (300); above
    that, `betweennessSamples` sources are drawn with `randomSeed` and the result is scaled by N/k.

### Discovery channels (crawler/src/discovery, core/src/discovery)

- `new DiscoveryRunner({ pool, redisUrl, prefix }).run(runId)` runs after a crawl. It uses the **same
  prefix** as the crawl so the throttle is shared. Each channel goes separately into
  `discovery_observations`, with `source_document` and a raw `detail` (provenance):
  1. `link_graph`: the seed (`kind: "seed"`) and every link observation (`linkObservationId`,
     anchor, region).
  2. `xml_sitemap`: pages in sitemaps found at conventional paths (`/sitemap.xml`,
     `/sitemap_index.xml`, `/sitemap.xml.gz`).
  3. `robots_sitemap`: pages in sitemaps declared by robots.txt. The `Sitemap:` lines themselves are
     stored with `detail.kind = "directive"` (sitemap files, not pages; reconciliation skips them).
     Sitemaps: indexes are followed to `sitemapMaxDepth`; gzip is detected by magic bytes; cycles
     are skipped; `detail` holds `rawLoc`, `lastmod`, `depth` and the `via` chain. A sitemap reached
     both ways credits both channels.
  4. `html_sitemap`: links outside page chrome on HTML sitemap pages. Candidates are links labelled
     "sitemap"/"site map" and conventional paths; a path hit must have "sitemap" in its title/h1.
     Pages already crawled reuse their stored body.
  5. `feed`: RSS 2.0, RDF and Atom entry links, from `<link rel=alternate>` in crawled pages and
     from conventional paths.
  6. `llms_txt`: Markdown links in `/llms.txt`, with their section.
- Discovery requests go through `fetchPage` (scope, robots.txt per hop, shared throttle). They are
  stored as `fetches.purpose = 'discovery'`, each document is requested at most once, and they count
  toward `discoveryMaxFetches`, **never `pageCap`**. robots.txt loading is shared with the crawl
  (`RobotsStore`, `purpose = 'robots'`).
- `reconcileDiscovery(db, runId, policyId)` (core) derives the policy's link graph for
  reachability, maps each internal non-directive observation to a node, and appends a
  `discovery-reconciliation` artefact:
  - `inventory` (union of channels) with per-node `channels`, `sources`, raw `urls`, `reachable`,
    `depth` and `orphan`
  - `orphans`: found by a non-link channel but not reachable in the link graph
  - per-channel `total`, `exclusive` (marginal yield) and `orphans`
- The P4/P5 context uses only `crawl` fetches, so discovery never changes a derived graph.

### Structural audit (packages/core/src/audit)

- `auditRun(db, runId, policyId)` derives the policy's graph and reconciliation in memory, runs the
  rules, and appends a `structural-audit` artefact `{ summary, issues }`. The pure core is
  `auditStructure`.
- Issue record: `{ id, type, rule?, node, severity (high|medium|low), evidence, policyVersion }`.
  Page-level rules apply to crawled pages only, using each node's representative page.

| Type                      | Rule                                                                                                                 | Severity                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| orphan                    | reconciled orphan, with `channels`/`sources`                                                                         | high if a sitemap lists it, else medium                         |
| deep-page                 | depth > `auditDeepPageDepth` (3)                                                                                     | high if > `auditDeepPageHighDepth` (6), else medium             |
| weak-authority            | PageRank < `auditWeakAuthorityPercentile` (20th, linear interpolation) of crawled pages                              | high if < `auditWeakAuthorityHighPercentile` (5th), else medium |
| outside-largest-scc       | reachable, not in the largest SCC                                                                                    | low                                                             |
| dead-end                  | no internal out-links                                                                                                | medium                                                          |
| noindex-nofollow-conflict | `noindex-in-sitemap` (high); `canonical-to-noindex` (high); `nofollow-sole-path` (medium); `internal-nofollow` (low) | per rule                                                        |

- noindex/nofollow come from meta robots **or** the `X-Robots-Tag` header (`none` = both).
- The summary has counts by type, severity and rule, `nodesWithIssues`, `pagesAudited`, and the
  thresholds used (including the computed PageRank cut-offs).

### Link health: broken links and redirect chains (packages/core/src/audit/link-health.ts)

- `loadLinkHealth(db, runId, policyId)` builds the report on request; nothing is stored and
  nothing is requested again. The pure core is `linkHealth` (`LINK_HEALTH_VERSION`).
- A link on a crawled page is joined to the crawl fetch of `stripFragment(resolved_url)`, the
  exact string the frontier admitted and requested. The final attempt (`final_fetches`, so a
  retried 5xx counts once) gives its outcome. Only crawl pages' links are used, and external
  and non-http links are left out by the crawler's scope rule.
  - **Broken**: the final status is 4xx or 5xx, answered directly or at the end of redirects
    (`hops` > 0).
  - **Redirect chain**: at least `linkHealthMinChainHops` (2) redirect hops (each 3xx of
    `redirect_chain`), with the chain, the final URL and status. It `endsBroken` when it ends in
    4xx/5xx or never reaches a page: its last response is still a 3xx (too many redirects,
    off-site or bad Location, a hop blocked by robots.txt). Single hops are only counted
    (`redirectTargets`).
  - Counted, not judged: `uncheckedLinks` (the target was never fetched: page cap, nofollow,
    unparsable) and `failedLinks` (fetched without a status: robots.txt, network error, timeout).
- Per target: URL, node under the policy, links, and the source pages (page, node, link count,
  distinct anchors and regions in document order). Broken targets are sorted by most links;
  chains by most hops, then most links. The summary adds counts per status code and the
  distinct broken source pages.

### Page importance (L12; packages/core/src/importance)

- **Page type** (`classifyPage`, rules in `config.pageTypeRules`): homepage, hub (category /
  hub), product, article (article / doc), utility (login, cart, account, search, tag) or other.
  Rule-based, first match wins, and the result names the rule (`rule`, `evidence`):
  1. the seed → homepage;
  2. a utility URL pattern or schema type;
  3. page-level schema.org types: product, then article, then hub;
  4. URL patterns (path + query, case-insensitive): product, then hub (so `/blog/page/2` is not
     an article), then article;
  5. structure, for crawled pages: hub when it has ≥ `hubMinBodyLinks` main-content links with
     ≥ `hubMinLinkDensity` of its words in links, or pagination with ≥
     `hubPaginationMinBodyLinks`; article with ≥ `articleMinWords` words and ≤
     `articleMaxLinkDensity` in links;
  6. otherwise other.
- **schema.org types** (`schemaTypes`): parsed from the stored raw HTML (`fetch_bodies`, read in
  batches), so it works on runs crawled before it existed. Only page-level types count:
  - JSON-LD roots, `@graph` members, and a WebPage's `mainEntity`;
  - microdata `itemtype` without `itemprop`;
  - a listing whose ItemList holds Products is a hub, not a product page;
  - breadcrumbs, WebSite, Organization, Person and the like are ignored.
- **Signals** (`pageSignals`, shared by the pipeline and the fixture tests): the body text's
  words, the node's out-links in the main content (dom_region main/body) and their anchor
  words, and pagination (a pagination region or rel=next/prev).
- **Importance** (`computeImportance`, `IMPORTANCE_VERSION`):
  `importance(v) = Σ w_i·x_i / Σ w_i` over:
  - the type prior (`pageTypePriors`);
  - the PageRank percentile (mid-rank);
  - 1 / (1 + depth), 0 when unreachable;
  - ln(1 + inbound main-content links) / ln(1 + the site's largest such count).

  The weights (`importanceWeights`: 0.4 / 0.25 / 0.2 / 0.15) and the priors are **heuristic**,
  not fitted to any outcome. An orphan (not a graph node) gets `detachedImportance`: only its
  URL's type prior counts.

- `loadImportance` (in memory) and `buildImportanceRun` (a `page-importance` artefact).
  `importanceFor` reuses the latest one of the current version, else builds it; the graph view,
  explanations and S_imp scoring use it.
- Tests: the rules and importance in core, plus the classifier on real HTML in
  `crawler/src/page-type.test.ts`:
  - `test/fixtures/page-types/`: product, category, login, search, tag, docs (microdata),
    structure-only article and hub, and a plain page. The fixture server does not serve them;
  - four pages of the crawler's fixture site.

### Text representation (packages/core/src/text)

- `buildTextRun(db, runId, policyId)` appends a `text-representation` artefact. The pure core is
  `buildTextModel`. Its documents are the policy's crawled nodes, each represented by the same page
  as in the link graph (`representativeFetchId`). `TEXT_VERSION` (`text@1.0.0`) is stored in the
  payload. **Bump it whenever the output can change.**
- Fields: **Title** = `<title>` and `<h1>`. **Links** = anchor texts of the page's own outgoing
  links whose `dom_region` is `main` or `body`; anchors pointing to the page are never used.
  **Body** = stored `body_text`, from which the extractor already stripped chrome using the region
  classifier that writes `dom_region`.
- Tokenising: NFKC, then lower-case, then apostrophes inside words are removed. The text is split
  into phrases at punctuation, and n-grams never cross a phrase or go from one field string to the
  next. Numbers, stop-words (`stopword` eng) and tokens shorter than `textMinTokenLength` are
  dropped, and a dropped stop-word does not break a phrase. What remains is Porter-stemmed
  (`stemmer`), then n-grams are built up to `textMaxNgram` (unigrams + bigrams).
- Boilerplate: document frequency is computed over the site (any field). The top
  `frequentNgramDropPct` of distinct n-grams by DF are dropped (ties: higher total count, then the
  term), but only n-grams in at least max(`frequentNgramMinDf`, ⌈`frequentNgramMinDocShare` × N⌉)
  documents (default: half the pages), so a topic that a few pages share is never dropped.
- TF-IDF per field: tf is the raw count; idf = `ln((1+N)/(1+df)) + 1`.
- Views: donor `S_A = Links ∪ Body` and target `S_B = Title ∪ Body` (B's own anchors are
  excluded). Each is stored as a sorted term set. `viewWeights` sums the field weights.

### REF matrix (packages/core/src/semantic)

- `buildRefRun(db, runId, policyId, variant)` builds the text model in memory (`loadTextModel`,
  with the run's stored config) and appends a `ref-matrix` artefact. The pure core is `refMatrix`.
  `REF_VERSION` (`ref@1.2.0`) and the text version are stored in the payload. **Bump it whenever
  the output can change.**
- Variants: `weighted` (default; `w_B` = the target view's summed field TF-IDF weights) and
  `unweighted`. `ref()` computes one pair.
- All ordered pairs u ≠ v, computed exactly but through an inverted index (CSR postings over
  interned term ids), so a donor only touches targets it shares a term with.
- ε cutoff: only REF > `config.epsilon` survives; REF ≤ ε is set to 0 and not stored. The matrix
  is sparse (COO, node indices, sorted by source then target); self-pairs are never stored.
- Per-node normalisation: `ρ(u,v) = REF(u,v) / Σ_w REF(u,w)` over u's stored entries, so each
  source's ρ sums to 1.
- Each stored pair keeps `matchedCount` and its `refExplainTerms` matched n-grams with the
  largest contribution (`w_B(t) / Σ w_B`, or `1/|S_B|` unweighted; ties by term), for explanations.
- Runtime at 500 pages (249,500 pairs): see `src/semantic/ref.bench.ts`. It is under 1 s even
  when every pair shares terms. A very low ε on a dense site stores every pair with an
  explanation (hundreds of MB), which is why ε matters.
- Optional candidate pre-filter (`config.refPrefilter`: `none`, the default, or `lsh-ensemble`;
  `semantic/lsh-ensemble.ts`). The payload's `prefilter` records it (null when exact).
  - LSH Ensemble (Zhu et al., VLDB 2016) for containment: the donors' S_A (only terms in some
    target) are indexed, and each target's S_B is a query at containment
    t* = `lshThreshold` (0.1, unweighted |S_B ∩ S_A| / |S_B|). The candidates are then scored
    exactly (`refMatrixPrepared` with per-donor candidates); a missed pair is absent, as if
    REF ≤ ε, and ρ is normalised over what was found.
  - MinHash: `lshNumPerm` (128) simple-tabulation hash functions drawn from `randomSeed`. They
    are near min-wise independent: on the test site the collision rate matched the prediction
    (0.977 observed, 0.971 predicted), where a seeded `fmix32(h ⊕ seed)` gave 0.853.
  - Donors are split into `lshPartitions` (16) equi-depth partitions by |S_A|. Each partition
    has a banded index per row count r = 1…`lshMaxRows` (16). A query picks, per partition, the
    (b, r) minimising `lshFalsePositiveWeight`·FP + `lshFalseNegativeWeight`·FN areas over
    containment (Simpson's rule, up to min(1, u/q)). J = x·q/(u + q − x·q) uses the partition's
    largest size u, and results are cached per log-size-ratio bin. A partition with u < t*·q is
    skipped (exact pruning).
  - Weighted REF can exceed ε with a lower unweighted containment, which is why t* < ε. The
    experiment below measures what is missed.

### Semantic engine: embeddings and cosine (packages/embeddings, core/src/semantic/cosine.ts)

- Model: `config.embeddingModel` (`Xenova/all-MiniLM-L6-v2`, 384-d) via `@huggingface/transformers`,
  `embeddingDtype` weights (`fp32`), mean pooling, L2-normalised.
- Input per document (core `embeddingInput`): the Title field (`<title>`, then `<h1>` unless it
  repeats the title), a newline, then the body cut to its first `embeddingBodyTokens` (256) model
  tokens (tokenizer encode → first N ids → decode). The representative pages are the same as for
  the text representation (`loadRunDocuments`).
- Cache: one file per embedding, `<cacheDir>/embeddings/<model>/<dtype>/<k[0..2]>/<k>.f32` (raw
  float32 LE, written to a temporary file and then renamed into place). `k` = SHA-256 of
  (`EMBEDDING_CACHE_VERSION`, model, dtype, pooling, normalise, body tokens, title, body). The
  model loads only on a cache miss, so a fully cached re-run never loads it. Model files go to
  `<cacheDir>/models` (or `modelDir`). `.cache/` is git-ignored.
- `EmbeddingWorker.start(embeddingOptions(config, cacheDir))` runs `EmbeddingEngine` in a
  `worker_threads` worker, so model load and inference never block the API. From TypeScript
  sources it boots through `worker-bootstrap.mjs` (registers tsx). Requests are served in order;
  vector buffers are transferred, not copied.
- `buildCosineRun(db, runId, policyId, embedder)` refuses an embedder whose model/dtype/body tokens
  differ from the run's stored config. It stores a `cosine-matrix` artefact (`COSINE_VERSION`):
  sorted `nodes`, per-node `contentKeys`, and the strict upper triangle (`upper`, row-major,
  `packedIndex`). Look pairs up with `cosineOf`.
- The integration test downloads the model once (~90 MB) into `packages/embeddings/.cache/models`.

### Prominence (packages/core/src/prominence)

The structural stand-in for the patent's session counts. Always call it **prominence**.

- `buildProminenceRun(db, runId, policyId)` takes the policy's link graph (the same representative
  pages and edges as `deriveGraph`) and appends a `prominence` artefact (`PROMINENCE_VERSION`).
  The pure core is `computeProminence`; `observationFactors` gives each observation's factors.
- `W(u,v) = Σ over observations u→v of regionWeight × positionFactor × sitewideDiscount`:
  - `regionWeight` = `prominenceRegionWeights[regionClass(dom_region)]`. The defaults are body 1.0,
    breadcrumb 0.5, aside 0.4, header 0.3, nav 0.3, pagination 0.2, footer 0.1. `main`, `body` and
    a missing region are body.
  - `positionFactor` = `1 / (1 + prominencePositionDecay × rank)` for body links (reasonable
    surfer). The rank counts the page's body links in `position_index` order, including external
    ones, and starts at 0. Other regions get 1.
  - `sitewideDiscount` = `prominenceSitewideDiscount` (0.3) when the link's `template_signature`
    is on more than `prominenceSitewideShare` (50%) of the representative pages, else 1.
- `ω(u,v) = W(u,v) / Σ_v W(u,v)`, or 0 when u's total is 0.
- Analytics (optional): `importAnalyticsCsv(db, runId, csv, name)` parses an RFC 4180 CSV
  (`source_url, target_url, clicks`: any column order and case, other columns ignored). Every
  problem is reported with its line, and nothing is stored if any row is invalid. Valid rows
  are stored raw in `analytics_clicks`. At build time the URLs are mapped through the same policy
  and context as the graph.
  - **The override is per source node.** A node with clicks on any of its edges uses clicks as W
    for all its edges (0 for those without clicks), so each ω row stays in one unit.
  - Rows that are not an existing edge are counted (invalid URL, external, self-loop, no link),
    not used. Each edge keeps `structuralWeight` for comparison.
- **Limitations.**
  - The region weights, position decay, site-wide threshold and discount are our assumptions.
    They were not fitted to click data, and the reasonable-surfer shape is borrowed, not
    measured.
  - Prominence is therefore a structural proxy for how likely a link is to be followed, not
    evidence of it. A single mis-classified region (e.g. a content block in an `<aside>`) shifts
    ω for that page.
  - Only representative pages are weighted, and a site-wide block is judged per signature, so a
    template whose signature varies across pages is not discounted.
  - Where analytics exist, prefer them. E-series results that depend on ω should report the
    weights used (`params` in the artefact).

### Diagnosis (packages/core/src/diagnosis)

- `buildDiagnosisRun(db, runId, policyId, variant)` computes the REF matrix (`variant`, default
  weighted) and prominence in memory with the run's stored config. It appends a `diagnosis`
  artefact (`DIAGNOSIS_VERSION`) that records the REF and prominence versions, the variant, α
  and ε. The pure core is `diagnose`; `classify(ρ, ω, hasEdge, α)` is the rule.
- Pairs: every (u,v), u ≠ v, with REF(u,v) > ε or a link u→v, when both ends have a text document.
  ρ is 0 when REF ≤ ε and ω is 0 without a link. Links to or from a node without text (not
  crawled as HTML) are counted as `skippedNoText`, not judged. ρ ≤ α with ω < α is
  `unclassified`.
- `α` (`config.alpha`, 0.1) is the diagnosis threshold for both ρ and ω: ρ must exceed it, and ω
  counts as prominent at ≥ α.
- Each diagnosis: `id` (`case:u->v`), case, label, REF, ρ, ω, severity `|ω − ρ|`, recommendation,
  `simulate` (v4 and v3 true; v1 is never simulated), the existing link (weight, observations,
  origin, regions) and REF's matched n-grams (for explanations).
- Order: case (v4, v3, v1, v2), then severity (highest first), then source and target. `counts`
  has each case, `unclassified`, `skippedNoText` and `pairs`.

### Fix candidates (packages/core/src/fixes/candidates.ts)

- `buildCandidatesRun(db, runId, policyId, variant)` computes the audit, REF matrix, prominence
  and diagnosis in memory with the run's stored config. It appends a `fix-candidates` artefact
  (`CANDIDATES_VERSION`). The pure core is `generateCandidates`.
- Targets (`candidateTargets`): the audit's orphan, deep-page and weak-authority nodes, and the
  targets of v4/v3 diagnoses, with every reason kept.
- Donor u for target v is admitted when, in order (the first failure is what the target's
  `rejected` counts):
  1. u is a same-site HTML page with text (a REF node) and u ≠ v (`self`);
  2. u is not a utility page: `candidateUtilityPatterns`, case-insensitive regexes on path + query
     (login, cart, account, search, tag archives) (`utility`);
  3. with `candidateSectionBlocking`, the sections are the same, siblings
     (`candidateSiblingSections`), or one is top level (`candidateTopLevelIsSibling`) (`section`).
     A section is the first path segment when the path has ≥ 2 segments (`/blog/x`, `/blog/`);
     `/`, `/about` and `/blog` are top level;
  4. REF(u,v) > ε (`ref-not-above-epsilon`);
  5. no body link u→v → **add-link** (a chrome-only link also counts as none), or a body link
     with ω(u,v) < α → **make-visible**. A body link with ω ≥ α is already prominent
     (`prominent-link`).
- At most `candidateMaxPerTarget` (30) per target, by REF (ties by donor); the rest are `capped`.
- Each candidate: action, rank, REF, ρ, the existing link (ω, body or not, regions), the target's
  reasons, the pair's v4/v3 diagnosis, the sections and their relation, and `reasons` (one
  readable line per rule).
- Orphans are never crawled, so they have no text here (`hasText: false`, no candidates). They
  get donors through orphan rescue (below).

### Counterfactual engine (core/src/fixes/counterfactual.ts, packages/counterfactual)

- `buildCounterfactualRun(db, runId, policyId, { variant, workers })` loads the fix candidates and
  a weighted link graph (`loadCounterfactualInputs`) and appends a `counterfactual` artefact
  (`COUNTERFACTUAL_VERSION`).
- Graph (`WeightedGraph`, compact CSR typed arrays): every node of the policy's link graph, links
  weighted by **structural** prominence W(u,v). Analytics clicks are never used here, so every
  row is in the same unit as the added body weight.
- Per candidate (`simulate`): a copy of the graph with u→v set to the body weight
  (`prominenceRegionWeights.body`). For make-visible the existing link is raised to it (never
  lowered). Weighted PageRank is recomputed, warm-started from the baseline vector, with the same
  damping, dangling rule, L1 tolerance and iteration cap as the graph metrics. It records
  W before and after, PR(v) before and after, ΔPR_v, the site-wide Σ|ΔPR| (L1), and depth_v from
  the home page before, after and Δ (null when unreachable), plus iterations and convergence.
- Validation (`validateWarmStart`): `counterfactualValidationSample` candidates, drawn with
  `randomSeed`, are re-run from a cold start. The L1 difference must be ≤ `pagerankTolerance`, and
  the result is stored in the artefact.
- Parallelism: `simulateInWorkers` hands out small chunks (about 4 per worker) to
  `counterfactualWorkers` threads (0 = half the logical processors, at least 1). Results come back
  in candidate order and do not depend on the worker count. Each worker reuses one `workspace`, so
  nothing is allocated per candidate (per-candidate typed arrays contended on the process
  allocator).
- `runtimeMs` per candidate and a `runtime` summary (workers, wall time, mean/p50/p95/max) are
  the only non-deterministic fields.
- Measured (i5-12450HX; 500 nodes, 14.5k links, 5,000 candidates): about 0.8 ms per candidate on
  one thread (4.2 s), and about 2.3 s with 6 workers. Past about 6 workers the performance cores
  are saturated.

### Editing effort κ (packages/core/src/fixes/effort.ts)

- `κ(u)`: the number of distinct `template_signature`s among the donor's body-region link
  observations (`regionClass` body: main, body or no region; unsigned links ignored), at least 1.
  A page whose body links sit in one block costs 1; each further block adds 1.
- `templateReach(u)`: the most pages (representative pages, links in any region) that carry one
  of the donor's body signatures; 1 when it has none. `templates` lists each body block with its
  page count, widest first. It is used in explanations ("this block is on N pages").
- `effortByNode(pages)` is pure. `loadDonorEffort(db, runId, policyId)` uses `loadPageLinks` (the
  same representative pages as the graph and prominence).
- **Limitation:** signatures are structural. A link directly under `<body>` has an empty ancestor
  chain, so every such page shares one signature and `templateReach` counts unrelated pages
  together (10 on the fixture site).

### Fix scoring and ranking (packages/core/src/fixes/scoring.ts)

- `buildFixRanking(db, runId, policyId, { sigmaVariant })` appends a `fix-ranking` artefact
  (`SCORING_VERSION`). Its inputs:
  - ΔPR and Δdepth: the run's latest `counterfactual` artefact for the policy;
  - cosine: the latest `cosine-matrix` artefact. The model is never loaded here; if either
    artefact is missing it throws;
  - REF, ρ and prominence: the fix candidates, recomputed with the counterfactual's REF variant,
    matched by candidate id, and checked against its `candidatesVersion`;
  - κ and templateReach: `loadDonorEffort`.
- σ variants (`sigmaValues`, all reported on every fix for E7; `config.sigmaVariant` picks the
  one that scores; a missing cosine counts as 0):
  - `cosineOnly`
  - `refOnly`
  - `refGateCosine` (default): cos if REF > ε, else 0
  - `blended`: `sigmaBlendLambda`·REF + (1 − λ)·cos
- `S(u→v) = ΔPR_v × σ(u,v) / κ(u)` (`fixScore`). A negative cosine gives a negative S, which
  ranks last.
- Optional scoring mode (`config.fixScoring`, default `S`; `buildFixRanking(…, { scoring })`):
  `S_imp(u→v) = S(u→v) × importance(v)` (L12, experimental), with the targets' importance from
  `importanceFor`. Every record keeps `scoreS` (S), `scoring` and `importance` (null under S).
  The ranking artefact records `scoring` (`SCORING_VERSION` scoring@1.2.0; an older ranking
  counts as S), and the API reuses only a ranking of the run's mode.
- Order: S (highest first), then ΔPR_v, then donor, then target. `rank` is global and
  `targetRank` is within the target. `topK(fixes, k)` and `topKPerTarget(fixes, k)` return the
  top k (`fixTopK`, default 10; tested with 10, 25 and 50).
- Each record: id, donor, target, type (add-link / make-visible), ΔPR, ΔPR L1, depth
  before/after/Δ, the σ used and every variant, REF, ρ, cosine, prominence (existing ω, link
  weight before and after), κ, templateReach, score, rank, targetRank, target reasons, diagnosis
  and policy version.

### Learned prioritiser (L13; eval/src/l13, analysis/ml, core/src/fixes/learned.ts)

An experimental, offline-trained alternative to S. **S stays the default**; "learned" only
reorders the fixes, and the rule-based explanation stays the explanation of record.

- Labels: E6 hide-and-recover. `e6Rows` masks `l13Repeats` (2) repeats exactly as E6 does
  (`maskSite`, `maskedInputs`), rebuilds the masked world in memory (`prepareRun`, re-embedded)
  and emits every candidate of every query (target, hidden donor): the hidden donor is the one
  positive, the other admissible candidates are negatives. Every feature is computed in the
  masked world, so no hidden link leaks. The `sigma_hybrid` column reproduces E6's refGateCosine
  metrics (tested). E8 ratings are a second label set when at least two sites have them.
- Features (`l13/features.ts`, `FEATURES`): ΔPR, depth gain, newly reachable, REF, cosine, term
  Jaccard, ω of the existing link (always 0 in E6 rows: candidates never link to the target),
  κ, template reach, donor/target PageRank, depth, in/out neighbours, largest-SCC flags,
  importance, same section, and the page types (categorical).
- `pnpm --filter @linklens/eval l13 export --batch <b> --out <dir>` writes
  `<batch>/l13/dataset/<site>/{e6,fixes,pool,ratings}.csv` and `dataset.json` (features, the
  `l13Lightgbm` parameters, `l13ShapTop`, seed, SHA-256 per file).
- `python -m ml train <dataset> --out <model>` (analysis/ml, LightGBM ≥ 4.3, `pip install -e
  ".[ml]"`): lambdarank grouped by query, **leave-one-site-out**: each site's predictions come
  from a model trained on the other sites only. Deterministic (seed, one thread). Priority =
  the raw score's mid-rank percentile among the site's fixes (in (0, 1)). TreeSHAP
  (`pred_contrib`, exact) gives each fix its top `l13ShapTop` (3) contributions. Writes
  `predictions/<site>.json`, `e6_metrics.csv` (learned vs S vs the σ hybrid, E6's metric
  definitions), `shap_sample.csv`, `model.json`.
- `l13 import --batch <b>` stores each site's predictions as a `learned-priority` artefact
  (`LEARNED_VERSION`) and writes `e3.csv` (E3 total ΔPR of the top k by S, learned and random).
  `python -m ml report <model>` writes `REPORT.md` (per-site E6, paired Wilcoxon learned vs S,
  E3, mean |SHAP|, verdict) and `figures/shap_summary` (beeswarm).
- API: `GET /audits/:id/fixes?scoring=learned` reorders by priority (`applyLearned`: score =
  priority, fixes without one last in S order; 409 without an artefact). Every fix carries
  `learned` {priority, raw, shap} (null without a model). The Fixes tab has a Scoring selector,
  and the explanation card shows "Model view (learned)" under the rule-based lines.
- **Limitations.** E6 labels are a proxy (a link the site already had), not editorial judgement;
  the learned mode is not validated by humans unless E8 ratings exist.

### GraphSAGE link predictor (optional; eval/src/l13/graph*.ts, analysis/ml/gnn.py)

Off by default (`config.graphsageEnabled: false`); the audit pipeline never runs it.

- `l13 graph-export --batch <b>` writes `<batch>/l13/graphs/<site>/` per completed site: the
  unmasked graph (`full`) and each of E6's `e6Repeats` masked repeats (`r<k>`, E6's own
  `maskSite`, seeds randomSeed + k). Nodes: the pages with text, sorted. Edges: distinct
  body-region links between them (self-loops dropped). Node features: the embedding (the run's
  model, re-embedded in the masked world as E6 does), then `STRUCTURAL_FEATURES` (PageRank × N,
  1/(1+depth), reachable, ln(1+in/out neighbours), importance). Per repeat also the E6 queries
  and every (target, candidate) pair with REF, cosine and the hybrid σ; these reproduce E6's
  refGateCosine and cosine metrics exactly (tested). Formats: `.nodes.txt`, `.x.f32` (float32
  LE, N × width), `.edges.csv`, `.queries.csv`, `.pairs.csv`, plus `graphs.json` (SHA-256 per
  file, the `graphsage` parameters, export time per site).
- `python -m ml gnn <graphs> --out <gnn> [--dataset <l13 dataset>]` (`pip install -e ".[gnn]"`;
  CPU torch from the PyTorch CPU index): `config.graphsage.layers` (2) SAGEConv layers with the
  mean aggregator on the undirected body graph, and a directed MLP decoder over [z_u, z_v].
  - Training is **leave-one-site-out** on the other sites' masked repeat graphs, so masked edges
    never enter training and the held-out site is never seen.
  - Each epoch splits every graph's edges into message passing and supervision
    (`supervision_share`), with `negative_ratio` sampled non-edges per positive and BCE loss.
  - Structural features are standardised per fold. Seeds: torch, NumPy and Python (PyG's
    negative sampler), one thread, deterministic algorithms (tested).
  - Writes `predictions/<site>.json` (the `graphsage-scores` payload), `scores/<site>/{e6,
    fixes,pool}.csv` (for the ranker), `e6_metrics.csv` (graphsage, hybrid, cosine, REF per
    repeat) and `runtime.csv` (export, train and score ms per site).
- `l13 graph-import --batch <b>` stores each site's `graphsage-scores` artefact
  (`GRAPHSAGE_VERSION`: nodes, per repeat each target's candidates and scores, fix scores).
- E6: with `graphsageEnabled`, `runExperiment("E6")` and the corpus export add the `graphsage`
  method from the run's latest artefact (`EXTERNAL_METHODS`; an unscored pair ranks last; a
  missing repeat or seed is refused). Without it the method is absent.
- L13 ranker: `python -m ml train <dataset> --graphsage <gnn>` adds the held-out score as the
  `graphsage` feature (NaN when unscored). A site's GNN score comes from a GNN that never saw it;
  the ranker for site X may use other sites' scores from GNNs that saw X's visible edges (never
  its hidden ones).
- `python -m ml gnn-report <gnn> [--ranker <m> --ranker-graphsage <m>]` writes `REPORT.md`: per
  site E6, GraphSAGE vs each baseline (Wilcoxon, Holm over the baselines), runtime, and the
  ranker with vs without the feature.

### Orphan rescue (crawler/src/rescue.ts, core/src/fixes/rescue*.ts, counterfactual/src/rescue.ts)

- `new RescueFetcher({ pool, redisUrl, prefix }).run(runId, policyId)` runs after discovery,
  with the crawl's prefix. It fetches each reconciled orphan's first raw URL once, going through
  scope, robots.txt per hop and the shared throttle.
  - Fetches: `purpose = 'rescue'`, one attempt, capped by `rescueMaxFetches` (never `pageCap`).
  - Stored: 2xx HTML is extracted into `pages` (and `fetch_bodies`). Links are **not** stored.
  - Isolation: `listPages(db, runId, "crawl")` feeds the graph, audit, text and discovery, so
    rescue pages never change a derived artefact.
- `buildRescueRun(db, runId, policyId, { variant, workers })` appends an `orphan-rescue` artefact
  (`RESCUE_VERSION`). It works in two stages:
  1. **REF shortlist** (`rescueShortlists`). The orphan's Title ∪ Body is weighted against the
     unchanged site text model (`externalTargetWeights`: the model's tokeniser settings, its
     boilerplate list dropped, its IDF, and the df = 0 IDF for unseen terms). A donor is admitted
     when it is a site page with text, reachable from the home page, not a utility page, in an
     allowed section, and has REF(u, orphan) > ε. The best `candidateMaxPerTarget` by REF are
     kept.
  2. **ΔPR order** (`rankRescue`). Each shortlisted donor → orphan link is simulated by the
     counterfactual engine, on the weighted graph plus the orphan nodes, in worker threads. The
     shortlist is ordered by ΔPR of the orphan (ties: REF, donor) and the top `rescueTopK` (5) are
     reported.
- Each orphan: node, raw URLs, channels, `revealedBy` (the non-link channels) with their source
  documents, status (`scored` / `no-page` / `no-text`), the rescue fetch, rejection counts, and the
  donors. Each donor has its rank, REF (and REF rank), ΔPR, ΔPR L1, depth after, and one readable
  reason per rule.
- Fixture: each orphan has a topical sentence that a reachable page covers (about.html, /blog/,
  the home page). sitemap-orphan is the control and gets no donor. The 7% boilerplate quota drops
  the deep pages' words on this small site, so they cannot donate.

### Explanations (packages/core/src/fixes/explain.ts, explain-run.ts)

- Deterministic templates only (no LLM, no SHAP). The same evidence always gives byte-identical
  text: fixed number formats (`f2` two decimals, `sci` 3 significant digits, `pct` one decimal),
  URLs shown as path + query (`shortUrl`), and fixed orders. **Bump `EXPLAIN_VERSION` whenever a
  template or format changes**, and update the snapshots on purpose (`vitest -u`), after reading
  the diff.
- `buildExplanations(db, runId, policyId)` explains every fix of the latest `fix-ranking`, every
  donor of the latest `orphan-rescue` (either may be absent) and every diagnosis. It appends an
  `explanations` artefact.
- Fix / rescue record (`explainFix`), structured, plus six `lines` and one `sentence`. A lookup
  can add two more lines: "Target page" after the target line and "Where" after the donor line.
  - `targetPage` (explain@1.3.0; L12): the target's page type, the rule that decided it, and
    its importance with the components and the depth and inbound links behind them (null
    without a lookup). An orphan gets its detached importance. Line: "Target page: /x is a
    product page (schema.org Product); importance 0.62 (type prior 0.80, PageRank percentile
    …, depth 2, 3 inbound main-content links)."
  - `needs` (why the target), in this order:
    - orphan, with the non-link channels that revealed it ("found only via the XML sitemap");
    - deep page (depth > threshold);
    - weak authority (bottom N% by PageRank, value < threshold);
    - v4/v3, with how many pages diagnosed it.
  - `donorEvidence`: REF, the top `explainTerms` (5) matched n-grams and cosine (null for
    orphans, which are not embedded). Each n-gram keeps its `term` (Porter stems, as matched) and
    adds `words`, the surface form that the lines and sentence quote ("turtle nesting", not
    "turtl nest").
  - `anchor`: the element-level REF result (below), or null when not computed. The sentence
    adds "anchor '…' in paragraph N" when there is one.
  - `link`: exists, ω and regions (e.g. "only from the footer").
  - `impact`: PR before and after, ΔPR and ΔPR % (null when PR before is 0), depth before, after
    and Δ.
  - `effort`: κ and templateReach.
  - `case`: the pair's v1–v4 label, or why there is none.
- Diagnosis record (`explainDiagnosis`): case, ρ, ω, α, REF, matched n-grams, link regions,
  severity, recommendation, and a per-case sentence (v1 says it is never simulated).
- Words (`text/surface.ts`, `SurfaceForms`): `wordPhrases` keeps each word as written next to its
  stem.
  - The run counts surface forms only for the terms it will quote, in every field of every
    document.
  - `of(term, [target, donor])` returns the most frequent form in the target's text, else the
    donor's, else the site's, else the stem. A tie goes to the shorter form, then the smaller.
  - Without a lookup, explanations quote the stems (explain@1.1.0 added the words).
- Tests: snapshot tests (inline for the key sentences, plus a file snapshot of the full output)
  on the four-case example, and end-to-end runs on the counterfactual and crawler fixtures.

### Anchor suggestions: element-level REF (packages/core/src/fixes/anchor.ts)

The patent's element-level REF, applied where the link would go. `buildExplanations` runs it
for every fix and rescue donor (explain@1.2.0); the pure core is `suggestAnchor`.

- Elements: the donor's `paragraphs` (the extractor's `<p>` and `<li>` of the main content; they
  ride along on `RawDocument`, which the text model ignores). Target: its **Title** field weights
  (`<title>` and `<h1>`, TF-IDF, boilerplate dropped); for an orphan, its rescue page's title
  weighted against the site model (`externalTargetWeights`).
- `REF(p, Title(v)) = Σ_{t ∈ S_p ∩ T_v} w_T(t) / Σ_{t ∈ T_v} w_T(t)` (or `|S_p ∩ T_v| / |T_v|`
  with the ranking's `unweighted` variant), S_p = the paragraph's n-grams under the site's
  tokeniser. The best paragraph (ties: the earlier) is used only when its REF is above
  `config.epsilon`.
- Anchor: the matched n-gram with the largest Title weight (ties: more words, the earlier
  occurrence, then the term), quoted **verbatim** from the paragraph: `text/tokenise.ts`
  `spannedPhrases` gives wordPhrases' words with their offsets in the original text (tested to
  agree with wordPhrases; null in the rare case where per-character NFKC differs from the whole
  text's), so "Terms of Service" is quoted for the term "term servic".
- Text the donor already links (its content-region anchor texts, the Links field, found verbatim
  in the paragraph by `linkedRanges`) is out of S_p and breaks n-grams: an anchor never wraps an
  existing link, and a paragraph that is only a link (a list of links) scores 0.
- Result: `suggested` (paragraph index and count, REF, term, weight and share of Σ w_T, the
  anchor, an `excerpt` of at most `anchorExcerptChars` (240) cut at word boundaries with the
  anchor's offsets, and the paragraph's top `explainTerms` matched n-grams with their words) or
  `none` with a reason (`no-paragraphs`, `no-title-terms`, `not-above-epsilon` with the best REF).
- Line: "Where: suggested anchor 'X' in paragraph N of M of /donor (REF to /target's title R > ε
  E): "… [X] …"", or why there is none and "write a sentence that introduces /target".
- **Limitations.** Paragraphs are `<p>`/`<li>` only (headings, table cells and bare text blocks
  are not candidates). A title of one generic word ("Orphan" on the fixture) rarely matches any
  paragraph. Linked text is found by exact substring, so an anchor whose text differs from how
  it renders in the paragraph (an image alt, an aria-label) is not excluded.

### HTTP API and pipeline runner (packages/api)

- `PipelineRunner` runs an audit through 18 stages in order: crawl → extract → discovery →
  canonicalise → graph → reconcile → issues → text → REF → embeddings → prominence → diagnosis →
  candidates → counterfactual → κ → scoring → rescue → explanations.
  - State: `audits` (policy, options, status, current stage) and `audit_stages` (per stage:
    status, start, finish, `duration_ms`, detail, error). These tables are mutable.
  - Resumable: `run` starts at the first stage that is not completed, and the crawl resumes
    through `CrawlOrchestrator.resume`. On boot, `recover()` resumes the audits and policy jobs
    a previous process left running (up to capacity; whatever a live instance holds is left to
    it). `rerunFrom(stage)` resets that stage and every later one.
  - Several instances (same Redis prefix) can serve one database (`leases.ts`, `events.ts`):
    - An audit runs under a Redis lease `<prefix>:lease:audit:<id>` (policy jobs:
      `lease:policy:<id>`), taken with SET NX, expiring after `apiAuditLeaseMs` (30 s) and
      renewed every third of that. So each audit runs in one instance only. `isActive` (async)
      is true while anyone holds the lease, and a crashed instance's audits can be resumed once
      its leases expire. `close()` gives the leases back.
    - Events go through Redis pub/sub (`<prefix>:audit-events`), so an SSE stream on any
      instance sees every instance's events. The SSE handler subscribes, waits for
      `eventsReady()`, and only then reads the snapshot, so no event falls in between.
  - Capacity: at most `apiMaxConcurrentAudits` (2) audits plus policy jobs per instance. Beyond
    that, creating, resuming, re-running (analytics upload) or ranking all policies is refused
    with 429 `too_many_audits` and `Retry-After: 30` (`CapacityError`). The analytics upload
    checks capacity before importing.
  - Durations are logged ("[audit N] text completed in 123 ms"). Every stage stores its
    artefacts with the audit's policy version. Extract, canonicalise and κ store small summaries
    (`extraction-summary`, `canonicalisation`, `donor-effort`); extraction itself happens during
    the crawl.
  - Events (`stage`, `progress`, `done`) go to the event bus and stream as SSE.
  - The embedder is injected: the MiniLM worker in `server.ts`, a stub in tests.
- `createApp({ service, apiKey?, webRoot? })` takes an `AuditService`, so tests can stub it. Every
  input is checked with zod (`schemas.ts`), queries before any database access. Errors are
  `{ error: { code, message, details? } }`: 400 validation / invalid_json / invalid_config /
  invalid_audit / invalid_csv, 401 unauthorized, 403 forbidden, 404 not_found, 409 not_ready /
  running / completed, 413, 415, 429 too_many_audits and 500 internal (logged, never leaked).
- Authentication (`auth.ts`), when `apiKey` (LINKLENS_API_KEY) is set:
  - Every route except `/health`, `/openapi.json`, `/docs` and `/session` needs the key, as
    `Authorization: Bearer <key>` or `X-API-Key`, or the session cookie. Otherwise the answer is
    401 with `WWW-Authenticate`. Keys are compared in constant time.
  - The cookie is for the dashboard, because EventSource, downloads and report links cannot send
    headers. `POST /session {key}` sets `linklens_session`: HttpOnly, SameSite=Strict, Secure
    over HTTPS. Its value is an HMAC of a fixed label under the key, never the key itself.
    `GET /session` returns `{ authRequired, authenticated }`, and `DELETE /session` signs out.
  - A state-changing request authenticated by the cookie with `Sec-Fetch-Site: cross-site` is
    refused (403).
  - Without a key the API is open, and `server.ts` logs that.
- Serving the dashboard: with `webRoot` (LINKLENS_WEB_ROOT; by default `packages/web/dist` when
  it is built), the API moves under `/api`, as behind the Vite proxy.
  - `/assets` is served immutable (the files have content hashes); `index.html` is served
    no-cache.
  - Other GETs that accept HTML get `index.html` (the SPA fallback).
  - The links and Location of `POST /audits` carry the mount (`req.baseUrl`), and Swagger UI
    loads `openapi.json` relatively.
  - `pnpm start` builds the web app and starts the API.
- Routes (OpenAPI 3.1 at `/openapi.json`, built from the zod schemas; Swagger UI at `/docs`):
  - `POST /audits` `{ url, pageCap?, policy (default P3), options { sigma, refVariant, workers,
config } }` returns 202 with a Location header.
  - `GET /audits`, `GET /audits/:id` (status, crawl progress, each stage and its duration),
    `POST /audits/:id/resume`, `GET /audits/:id/events` (SSE: snapshot, stage, progress, done;
    closes when done).
  - `GET /audits/:id/summary`, `/graph?policy=` (another policy is derived on demand; with
    `importance`, each node's page type and importance once the run is complete),
    `/issues?policy=&type=&severity=`, `/diagnosis?case=`, `/fixes?sigma=&k=10|25|50&scope=` (a
    ranking for another σ is computed from the stored counterfactual and stored), `/orphans`, and
    `/sensitivity` (all six policies: size, reachability, orphans, issues, top-10 PageRank Jaccard
    in P3 form).
  - `GET /audits/:id/reconciliation`: the discovery inventory, each URL's channels (orphans
    first) and each channel's total, exclusive (marginal yield) and orphan counts.
  - `/sensitivity?k=` compares each policy with the audit's, pages matched in P3 form (a P3
    page's PageRank is the sum of its merged nodes', its depth the smallest). Columns: nodes,
    orphans, issues, mean depth, Spearman of PageRank, mean (and mean absolute) depth shift, and
    the Jaccard of the top-k fixes as (donor, target) pairs.
  - `POST /audits/:id/sensitivity/fixes` fills the Jaccard column by running `RANKING_STAGES`
    (graph … scoring) under every policy that lacks a ranking for the audit's σ. It runs in the
    background (`PipelineRunner.rankAllPolicies`, status in `fixesJob`), and its artefacts carry
    each policy's version.
  - `GET /audits/:id/report`: a printable HTML report. It is rendered server-side, every value
    goes through `esc`, and there are no scripts beyond the print button.
    `GET /audits/:id/export/:file` serves one file of the export.
  - `POST /audits/:id/analytics` (text/csv) imports clicks and re-runs from prominence.
  - `GET /audits/:id/export`: a zip of JSON and CSV (audit, summary, issues, diagnosis, fixes,
    orphans, explanations). `fixes.csv` has `suggested_anchor`, `anchor_paragraph` (1-based) and
    `anchor_ref` (empty without a suggestion). With a rating sample, `ratings.csv` has every answer
    (history included) with the item's rank, which the raters never saw. Once the crawl has
    completed, `broken-links.csv` and `redirect-chains.csv` have one row per source page and target
    (the chain as `url (status) -> …`).
  - `GET /audits/:id/links`: the link-health report (409 until the crawl stage has completed).
  - E8 rating page (`core/src/rating`, `RATING_VERSION`; only the database):
    - `GET /audits/:id/rating?rater=A|B` returns the blind sample (`sample: null` and `canCreate`
      until one exists) and **only that rater's own** latest answers.
    - `POST /audits/:id/rating/sample` draws the sample once per audit; asking again returns it,
      so both raters rate the same items.
    - `POST /audits/:id/rating/answers` takes `{ itemId, rater, name, relevant, placement }`
      (an invalid rating gives 400 `invalid_rating`).
    - `GET /audits/:id/rating/summary` returns precision@k and agreement.
  - A fix's (or rescue donor's) `explanation` is `{ sentence, lines, anchor }`.
- Threads: the database-only stages (`stages.ts` `DB_STAGES`: extract, canonicalise, graph,
  reconcile, issues, text, REF, prominence, diagnosis, candidates, κ, scoring, explanations) run in
  a `StageWorkerPool` of `apiStageWorkers` (2) long-lived worker threads, each with its own pg
  pool. This needs `databaseUrl` in the deps; with 0 workers they run on the main thread.
  - A stage waits for a free worker. A worker that dies fails its stage and is replaced.
  - From TypeScript sources the workers load through `worker-bootstrap.mjs` (tsx).
  - Crawl, discovery and rescue do I/O. Embeddings and counterfactuals have their own worker
    threads.
- Policy jobs are rows in `policy_jobs` (status, done, current, error; one per audit), so
  `policyJob` (async) reads the same state on every instance, and an interrupted job resumes.
- Run it: `pnpm --filter @linklens/api start`, or `pnpm start` with the dashboard. It reads the
  repository's `.env`, and real variables win. Env: DATABASE_URL or PG*, REDIS_URL, PORT,
  LINKLENS_CACHE_DIR, LINKLENS_PREFIX, LINKLENS_USER_AGENT, LINKLENS_API_KEY and
  LINKLENS_WEB_ROOT (`none` turns the dashboard off).

### Web dashboard (packages/web)

- React 18 + Vite + TypeScript, TanStack Query and React Router 7. Plain CSS: design tokens and
  namespaced classes in `styles/app.css`; no UI kit.
- `api/`: `types.ts` holds hand-written response shapes of the API. `client.ts` is a fetch wrapper
  that turns `{ error }` bodies into `ApiError` and dispatches `linklens:unauthorized` on a 401. `queries.ts` has the query hooks (finished
  results use `staleTime: Infinity` and are invalidated when the audit finishes) plus
  `useCreateAudit`, which creates the audit and then uploads the CSV, before the pipeline reaches
  prominence. `useAuditEvents.ts` is the SSE live state (`applyEvent` is pure) with a polling
  fallback.
- Routes: `/` (audits list), `/audits/new` (form: URL, page cap, policy, σ, optional CSV), and
  `/audits/:id/:tab` with the tabs summary, graph, fixes, diagnosis, orphans, links,
  canonicalisation, rating and export. The live progress panel (bar + 18 stages with durations + crawl counter + resume) shows
  while an audit runs or after it fails.
- Graph tab (`features/graph`): Cytoscape.js with the fcose layout, loaded lazily (its own chunk).
  - `model.ts` (pure, tested) builds the elements:
    - node size is √PageRank;
    - colour is the depth band or the most important issue (both precomputed, so the toggle
      recolours without a new layout);
    - every orphan sits in a highlighted "Orphans" compound cluster, added when the link graph
      lacks it;
    - parallel links collapse into one edge per pair, styled by its most prominent `dom_region`.
  - Rendering is capped at the top N pages by PageRank (100/300/1000; the home page and orphans
    always shown) and 1500 edges, main content first. A notice says what is hidden. Large graphs
    use `textureOnViewport`, `hideEdgesOnViewport` and pixel ratio 1.
  - The policy selector re-fetches the graph and its issues (`/issues?policy=`).
  - Clicking a node opens `NodePanel`: metrics, the page type with the rule that decided it and
    its importance with the components (L12; `importance` in the graph response), issues with
    evidence, inbound and outbound links (region, count, anchors), and the fixes that target it. Fixes exist only under the audit's
    policy. "Preview fix" overlays the suggested edge, dashed, adding its end points if the cap
    hid them.
- Result tabs:
  - Fixes: the top k from the API, sortable client-side (`sortFixes`: score, ΔPR, Δdepth, σ, κ,
    type; a newly reachable page counts as the largest depth gain). Each row expands into an
    `ExplanationCard`: the anchor block first (`AnchorBlock`: the suggested anchor, paragraph N
    of M, REF to the title, and the excerpt with the anchor in a `<mark>`; or why there is
    none), then the other lines (the "Where" line is the block), then the numbers.
  - Diagnosis: case count cards (they filter), a table sorted by severity, and an SVG scatter.
    ρ (or raw REF) is plotted against ω with α lines (ε when on REF), at most 3000 points,
    evenly strided.
  - Orphans: the reconciliation table (URL × six channels, a footer with totals, marginal yield
    and orphans) plus the rescue donors.
  - Canonicalisation: the sensitivity table, with a button that starts the per-policy ranking
    job. It polls while the job runs.
  - Links (`features/links`), shown once the crawl has completed:
    - stat cards for broken targets (links and source pages), redirect chains (longest,
      redirected targets) and internal links checked (not fetched, no answer);
    - "Broken internal links": a status badge, the target (after N redirects to …), link count
      and a filter All / 4xx / 5xx. A row opens the source pages with their anchors and
      regions, and the chain when there is one;
    - "Redirect chains": hops, the linked URL, where it ends (with the status, or why it never
      reaches a page), links. A row opens the chain hop by hop (URL and status) and the source
      pages.
  - Rating (`features/rating`, E8): two raters mark a blind sample of top fixes.
    - Each rater picks slot A or B and a name (kept in localStorage, a convenience only).
    - Each card shows the From and To pages (titles and links), the action, and the suggested
      paragraph with the anchor marked (`AnchorBlock blind`: no REF). The answers are Relevant /
      Not relevant, and placement Good / Acceptable / Poor / N/A.
    - Not relevant saves at once as n/a. A relevant item is saved once its placement is chosen
      (at once as n/a when nothing was suggested).
    - Precision@k and κ sit in a folded "Results" card; the summary is only fetched when it is
      opened, so it does not bias the raters.
  - Export: the report, the zip and every single JSON/CSV file.
- Sign-in (`features/session`): `SessionGate` wraps every page. It shows `SignIn` when
  `GET /session` says a key is needed and this browser has no session. It asks again after any
  401, and shows the page if the session cannot be read. The key is exchanged for the cookie and
  is not stored by the page. "Sign out" is in the header.
- Dev: `pnpm --filter @linklens/web dev` (proxy `/api` → `localhost:3001`). In production the
  API serves the built app itself (see above).
- Tests: Vitest + Testing Library with mocked `fetch` and `EventSource` (`src/test/utils.tsx`;
  `GET /session` answers "no key needed" unless a test mocks it, and is not recorded in `calls`).
  `test-setup.ts` strips the `signal` from `Request`, because jsdom's AbortSignal is not the one
  Node's Request accepts.
  Test files run in parallel, so `testTimeout` is 20 s and Testing Library's `asyncUtilTimeout`
  5 s: user-event flows take seconds on a busy machine.

### Evaluation (packages/eval, analysis/)

- `runExperiment(db, "E1"…"E8", { runId, policy, … })` runs an experiment on a stored, audited run
  and appends an `evaluation-E<n>` artefact. The CLI is
  `pnpm --filter @linklens/eval e E3 --run 12 [--policy P3] [--out results/e3.json]`; it needs
  DATABASE_URL.
  - **E1** policy sensitivity: each policy against the audit's (`stats.sensitivityFromSnapshots`,
    the same as `/sensitivity`) and `pairs`, every unordered pair of P0–P5
    (`stats.comparePolicyPairs`, 15 pairs, a before b, signed values b − a). Both come from one
    `stats.loadPolicySnapshots` (each policy's graph, orphans and top-k fixes in P3 form). Per
    pair: node counts (b − a, b / a), shared P3 pages and their Jaccard, orphan set Jaccard,
    PageRank Spearman over the shared pages, depth shift over pages reachable under both (mean,
    mean |·|, max |·|), and the top-k fix Jaccard (null unless both policies were ranked).
  - **E2** channel ablation: every subset of the five non-link channels (orphans found, recall,
    pages known), each channel alone, and leave-one-out loss. Plus `removals`: each of the six
    channels removed in turn and the reconciliation recomputed from the remaining observations
    (core `discovery.leaveOneChannelOut` on `loadReconcileInput`). Per channel: pages found and
    lost without it (marginal page yield), orphans it detects and those lost without it
    (detected only by it; marginal orphan yield) with their share of the orphans. `orphansBy`
    splits the orphans by the non-link channels that reveal them (only one, per channel, or
    several). Removing a channel never creates an orphan (checked), and removing the link graph
    loses pages but never an orphan.
  - **E3** fixes vs baselines (`e3-baselines.ts`; decided: three baselines). Targets T: the
    audit's weak-authority pages and the reconciled orphans. Pool: the fix candidates of
    weak-authority targets and each orphan's rescue shortlist, all on orphan rescue's graph
    (structural prominence W plus the orphan nodes). Each entry is simulated alone for its ΔPR;
    cosine comes from an embedder with the run's model (the orphans' rescue pages are not
    embedded by the pipeline, so E3 needs one: the CLI starts the MiniLM worker). Methods, each
    a global top-k over the pool: `linklens` (S = ΔPR × σ / κ with the run's σ), `random`
    (the mean of `e3RandomDraws` seeded draws, seed + k per k), `highestCosine` (ignores the
    graph gain; no cosine ranks last) and `highestPagerank` (the donor's PageRank; ignores
    semantics). The measure: the k links applied together (core `fixes.applyLinks`: one copy,
    PageRank recomputed warm-started) and ΔPR summed over T (`totalDeltaPr`), for each k in
    `e3TopKs` (10, 25, 50). Also: fixes selected, targets covered, the sum of single ΔPRs (the
    joint effect is not additive), site-wide L1, newly reachable targets, mean REF and cosine.
  - **E4** re-crawl stability (`e4-stability.ts`, `--run-b`): two runs of a site compared in P3
    form, site change separated from method instability.
    - Pages (`classifyPages`): crawled in both → `unchanged` or `changed` (signature: title,
      h1, body, meta robots, canonical, nofollow, every out-link with anchor, region and rel, in
      order). Crawled once → the other run's own record gives the cause: site (`gone` 4xx,
      `redirect` elsewhere, `not-html`, `robots` rule or Crawl-delay, `link`: nothing linked to
      it) or crawl (`not-admitted`: linked but not admitted, the cap or order; `failed`: 5xx,
      network, timeout, robots.txt unreachable). Discovery documents compare by their URL sets.
    - The audit (node overlap, PageRank Spearman, orphan Jaccard, top-k fix Jaccard) is compared
      `observed`; `siteChange` (each run restricted to the pages both crawled plus its
      site-caused ones: coverage noise removed); `samePages` (both restricted to the unchanged
      pages and documents: identical inputs, so any difference is the method's); and
      `coverageA`/`coverageB` (each run with and without the pages the other missed for crawl
      reasons).
    - The restricted audits run in memory (`in-memory.ts` `auditInMemory`: graph,
      reconciliation, structural audit, text, REF, prominence, diagnosis, candidates,
      counterfactual, κ, scoring, with the run's stored cosine matrix). Unrestricted it
      reproduces the stored ranking (tested).
  - **E5** Screaming Frog calibration (`e5-screaming-frog.ts`; `--sf-dir <folder>` with
    internal_all.csv, all_inlinks.csv, orphan_pages.csv, or `--sf internal_all.csv` alone).
    Parsers find columns by name and skip Screaming Frog's title line. `calibrateRun` maps both
    tools' URLs through P0 and the audit's policy (the run's redirect/canonical context) and
    compares, per policy: URL sets (HTML 200: Jaccard), inlinks (Spearman against distinct
    sources recomputed from All Inlinks hyperlinks under the same policy, and against SF's Unique
    Inlinks column), crawl depth (exact, ±1, Spearman, mean |Δ|, whether the seeds differ) and
    orphans (SF's orphan report against the reconciled orphans).
    - Every disagreement gets a category by ordered rules, with evidence (`EXPLANATIONS`, one
      sentence each, filled from the evidence). URL only in SF: `normalisation` (they meet under
      the coarser policy), `out-of-scope`, `robots-linklens`, `status-linklens`, `page-cap`
      (linked, not fetched, cap reached), `not-fetched`, `sf-non-link` (no SF inlink),
      `link-not-extracted` (SF link types quoted: JavaScript, canonical…), `sources-not-crawled-
linklens`. URL only in LinkLens: `normalisation`, `status-screaming-frog`, `nofollow`,
      `link-not-in-screaming-frog`, `sources-not-crawled-screaming-frog`, `not-in-screaming-frog`.
      Depth: `seed-differs`, `redirect-hop`, `link-not-extracted`, `parent-not-crawled-*`,
      `nofollow-path`, `link-not-in-screaming-frog`, `cascade`, `other`. Inlinks (a gap of at
      least `e5InlinkMinAbsDiff` and `e5InlinkMinRelDiff` of the larger count): the dominant cause
      of the missing or extra sources. Orphans: `reachable-*`, `not-in-linklens-channels`,
      `not-crawled-linklens`, `channel-screaming-frog-does-not-read`, `not-in-screaming-frog-
orphans`.
    - Categories are summarised per kind (count, share, `e5Examples` examples, explanation);
      one is `large` at `e5LargeShare` of its kind and at least `e5LargeMin`.
  - **E6** link-masking recovery (`e6-masking.ts`; needs an embedder: the CLI starts the
    worker). Editorial links (`editorialSite`): body-region observations between two pages with
    text whose template block is not site-wide. Each of `e6Repeats` (5) repeats (seed + r) masks
    a share drawn in [`e6MaskShareMin`, `e6MaskShareMax`] (10–20%) of those pairs (`maskSite`):
    every observation of a masked pair leaves the graph, its anchor leaves the donor's Links
    field and, with `e6StripAnchorsFromBody` (default on; body_text contains link text, so it
    would otherwise leak), its first occurrence in the donor's body. The text model, REF and the
    embeddings are rebuilt from the masked site. Each masked edge is a query (`rankMasked`):
    candidates are every page with text except the target, pages still linking to it and its
    other masked donors. Methods: `ref`, `cosine`, `jaccard` (donor view vs target view terms),
    `refGateCosine` (the hybrid), `blended`, `random`, and with `e6GraphBaselines`
    `commonNeighbours` / `adamicAdar` (undirected, on the masked graph). Recall@k (`e6Ks`
    5/10/20), MRR and AUC are expectations over random tie-breaking, so random is exactly k/N,
    H_N/N and ½.
  - **E7** σ / ε / α ablation (`e7-ablation.ts`; needs an embedder). `e7Settings`: each σ at
    the default ε and α, each σ along `e7Epsilons` (0.05–0.40, default α) and along `e7Alphas`
    (default ε), each setting once. Per setting: the fix ranking again (`prepareRun(...).rank`:
    graph, audit, text, prominence and κ once; REF, diagnosis, candidates and counterfactual per
    (ε, α), cached; scoring per σ), its top-k (`fixTopK`) Jaccard with the default setting's; E3
    (`loadE3Data` once, `buildE3Inputs` per setting; LinkLens's top-k applied together and the
    random baseline, per k of `e3TopKs`); E6 recovery of the σ (one masking run with the hybrid
    also gated at every swept ε; cosineOnly → cosine, refOnly → REF, blended; α does not enter
    E6). Plus the pairwise top-k Jaccard between σ variants at the default ε and α. At the
    default setting E3 and E6 agree with the experiments run alone (tested).
    - The scoring sweep (L12): each σ at the default ε and α also under `S_imp`
      (`prepareRun(...).rank({ scoring })`; importance computed once, lazily).
    - E3 then ranks its pool by S × importance(target); an orphan uses its detached importance.
    - E6 is unchanged by construction: one target's donors share its importance.
  - **E8** human rating: without `--ratings` it writes a rating sheet (CSV, top 50 fixes with
    their explanation). With the filled sheets it summarises mean relevance, would-add rate,
    top-10 vs rest, score–relevance Spearman and inter-rater agreement. The dashboard's rating
    page (below) is the interactive version.
- E8 rating page (core `rating/`): blind samples, two raters, precision@k and Cohen's kappa.
  - `buildRatingSample` draws `ratingSampleSize` (50) fixes with `randomSeed` from the top
    `ratingPoolSize` (50) of the latest fix ranking for the audit's σ. With pool = size every
    top-50 fix is rated, in a random order.
  - Each item (`SampleItem`) has the donor and target with their titles, the action and the
    suggested placement (`anchor` from the latest explanations). Its rank is stored but
    `blindItems` drops it: no score, rank, ΔPR, REF, σ or explanation reaches a rater.
  - The sample is a `rating-sample` artefact. Answers are append-only `fix_ratings` rows, and
    the latest per (sample, rater, item) counts (`latestAnswers`).
  - `recordRating` refuses an item outside the sample and a not-relevant item whose placement
    is not n/a.
  - `summariseRatings`:
    - per rater: rated, relevant and `precisionAtK` at `ratingKs` (5/10/25/50), over the rated
      items with rank ≤ k, plus the placement counts;
    - consensus: `strict` (relevant to both, over items both rated) and the `mean` of the two
      raters' precision (null unless both have one);
    - agreement over items both rated: relevance observed agreement and Cohen's κ (null when
      p_e = 1). Placement is judged over items both marked relevant and neither n/a: observed
      agreement, κ, and linear-weighted κ over good > acceptable > poor.
- Proxy validation (`proxy-validation.ts`). The CLI is `pnpm --filter @linklens/eval proxy` with
  `--run <id>`, optional `--policy P3` and `--out f.json`; it needs DATABASE_URL. Does
  **structural** prominence track real
  clicks? The analytics override is never used here: it is what is being validated.
  - `--analytics <csv>` (source_url, target_url, clicks) or `--stored` (the run's imported
    rows): link level. For each source with clicks on one of its crawled links, every out-link's
    ω(u,v) against its share of the source's clicks (0 without clicks).
    - Reported: the Spearman pooled over links, the mean within-source Spearman (sources with ≥
      `proxyMinEdgesPerSource` links), and hit@1 (the most prominent link is the most clicked;
      ties split).
    - Baseline: the link-count share (observations), which plain PageRank uses.
    - Rows are accounted for: used, no crawled link, external, invalid, self-loop.
  - `--gsc <csv>`: page level, from a Search Console "Pages" export (page and clicks columns
    found by name; thousands separators allowed; `SearchConsoleCsvError` lists bad lines).
    - Each crawled page's clicks, mapped through the policy, against inbound prominence
      Σ_u ω(u,v) and prominence-weighted PageRank (structural W). Baselines: PageRank by link
      multiplicity and distinct in-degree.
    - Pages in both the crawl and the export are compared; with `--zero-fill`, crawled pages
      missing from the export count as 0.
  - Every Spearman has a seeded bootstrap 95% CI (`proxyBootstrap` resamples of sources or
    pages, `randomSeed`). The prominence-minus-baseline difference is bootstrapped paired.
  - The report prints Markdown and states the prominence weights used (`proxyParams`).
- LSH pre-filter experiment (`lsh-prefilter.ts`). The CLI is `pnpm --filter @linklens/eval lsh`
  with `crawl`, `status` or `run`, and `--batch <name>`; output goes to `results/lsh/<name>/`.
  - `crawl --sites a,b,c`: each corpus site crawled once, sequentially, at the largest of
    `lshEvalCaps` (500/1000/2000), with the corpus config. It is resumable, and `manifest.json`
    holds the config hash, git state and run ids.
  - A cap N is the first N admitted URLs of that crawl (`admissionRanks`: with BFS and one
    worker, a cap-N crawl admits the same URLs in the same order). It keeps the documents whose
    representative page was among them, and the text model is rebuilt at that cap.
  - `run`: per cap and REF variant, the truth is the exact inverted index, checked pair by pair
    against a brute-force loop (`bruteForceRef`, `ref()` on every pair; `--no-brute-force`
    skips it). One LSH index per cap is queried at each of `lshEvalThresholds`
    (0.05/0.1/0.2).
  - Reported: candidate recall, REF-mass recall, recall of each target's top
    `candidateMaxPerTarget` donors, precision and candidate share. Runtimes are the median of
    `lshEvalRepeats` (brute force runs once): exact = interning + inverted index; LSH =
    interning + hashing + MinHash + index + queries (tuning included) + exact scoring.
  - Output: `lsh.csv` (`LSH_COLUMNS`: site × cap × variant × threshold × metric) and `lsh.json`
    (parameters, host CPU, git state).
  - Python: `python -m linklens_analysis lsh <dir> [--variant] [--figures <dir>]` (`lsh.py`).
    `summary_table` (per site × cap at `lshThreshold`, with speed-ups), `threshold_table` (mean
    over sites per cap × threshold) and `figure` (recall vs cap per threshold; log runtime vs
    cap for brute force, exact and LSH). The fixture in `analysis/tests/fixtures/lsh/` is written
    by the eval unit test with `LINKLENS_WRITE_FIXTURES=1`.
- `analysis/` (Python): `python -m linklens_analysis report results/*.json` prints Markdown
  tables. It adds paired Wilcoxon tests (E3: LinkLens vs each baseline; E7: σ pairs) and seeded
  bootstrap CIs for MRR. Its tests read fixtures written by the eval integration test with
  `LINKLENS_WRITE_FIXTURES=1`, so both sides share one shape.

### Corpus runner (packages/eval/corpus.yaml, src/corpus/, src/corpus-cli.ts)

- E5 Screaming Frog sites: 10 sites have `screaming_frog: true` (4 blogs, 3 catalogues, 3
  documentation sites). Crawl each with Screaming Frog from the same URL, export Internal: All,
  Bulk Export → Links → All Inlinks and Reports → Orphan Pages, and run `corpus import-sf
--batch <name> --site <id> --from <folder> [--sf-version <v>]`: the three files are parsed
  (a foreign file is refused), copied to `<batch>/screaming-frog/<site>/` and recorded with row
  counts and SHA-256 in `import.json`. `status` shows which marked sites still lack exports.
- `corpus.yaml`: 28 sites in three `architecture_class`es (`cms-blog`, `ecommerce-catalogue`,
  `documentation`), each with notes, plus one `seed`, the audit's `policy`/`sigma`/`refVariant`
  and `config` overrides (keys of `config.ts` only; `randomSeed` comes from `seed`).
  `rankAllPolicies` (default true) also runs the API's per-policy ranking job after each audit
  (`PipelineDriver`, resumable, under its lease), so E1 can compare fix lists between policies;
  a site is completed only once that job is.
  `parseCorpus` (zod) reports every problem at once. Scope is the seed's host, so a seed path is
  only where the crawl starts.
- CLI: `pnpm --filter @linklens/eval corpus validate | run | status | recrawl | schedule |
import-sf | export --batch <name>` (`--corpus`, `--out` default `results/corpus`, `--only a,b`,
  `--retry-failed`, `--allow-code-change`).
- E4 re-crawl (`corpus/recrawl.ts`): `recrawl` runs the batch's second wave in
  `<batch>/recrawl` (its own manifest, `wave: { of, afterDays }`). A site is due
  `e4RecrawlDays` (14) after its first run finished (`recrawlPlan`; an interrupted re-crawl is
  resumed whatever the date); only due sites run, so it is meant to run daily. `--now` is the
  manual trigger. The wave must match the first batch (config, audit settings, versions, sites,
  embedding model hash, and code unless `--allow-code-change`). A lock file (`.lock`, stale when
  its process is gone) keeps two sessions apart. `schedule [--at HH:MM]` prints the daily
  Windows Task Scheduler and cron lines (it installs nothing). `status` shows each site's
  re-crawl and when it is due. It reads the repository's `.env`; DATABASE_URL, REDIS_URL,
  LINKLENS_PREFIX, LINKLENS_CACHE_DIR (default `.cache/linklens`), LINKLENS_USER_AGENT.
- `run` audits the sites **sequentially** through the API's `PipelineRunner`
  (`@linklens/api/pipeline`; `PipelineDriver`), so an audit is the same 18 stages, leases and
  events as one from the dashboard. The resolved config (defaults + overrides + seed +
  User-Agent) is stored as each run's config.
- Resumable: `<out>/<batch>/manifest.json` is the batch state, written atomically after every
  change. A site's run id is saved as soon as the run exists, so running `run` again resumes
  that run (first stage not completed; the crawl from its Redis frontier) instead of starting a
  new crawl. Completed sites are skipped and failed ones only re-run with `--retry-failed`.
  SIGINT/SIGTERM stop after saving (the current site stays resumable); a killed process's
  session is marked `crashed` and its audit is resumed once its lease expires.
- Resuming refuses a different config, audit settings, stage versions or site list (notes may
  change), and a different commit or uncommitted diff unless `--allow-code-change`.
- The manifest is the reproducibility record: git commit, branch, dirty files and a hash of
  `git diff HEAD`; the full config and its hash; seed; User-Agent; the six policy versions and
  every stage version (`currentVersions`); the embedding model's name, dtype, body tokens and a
  SHA-256 over its files (null until the first cache miss downloads it); the pnpm lockfile hash;
  one `session` per invocation (timestamps, git, host, outcome); per site status, run id,
  attempts, timestamps, error, and the commit and model hash it finished with; each export.
- `export` writes tidy CSVs (columns in `csv.ts`, the contract with analysis/):
  - `metrics.csv`: one row per site × policy × metric (completed sites; `runMetrics` derives all
    six policies in memory from the raw observations, writing nothing). Groups: `graph.*`,
    `discovery.*` (per channel), `audit.*`, `ref.entries`, `diagnosis.*`, `sensitivity.*`
    (against the audit's policy, as E1), and `fixes.*` / `rescue.*` only where a ranking or
    rescue was stored under that policy. A metric without a value is left out, never written as 0. Rows are in corpus, policy and metric order, so an export is byte-identical when re-run.
  - `policy_pairs.csv` (E1): one row per site × pair of policies × metric (`pairMetrics`:
    `nodes_a`, `nodes_b`, `node_delta`, `node_ratio`, `shared_nodes`, `node_jaccard`,
    `orphans_a/b`, `orphan_jaccard`, `pagerank_spearman`, `depth_pages`, `mean_depth_shift`,
    `mean_abs_depth_shift`, `max_abs_depth_shift`, `top_fixes_jaccard`), with `top_k`.
  - `e7.csv` / `e7_sigma_pairs.csv` (E7, needs the embedder; E3, E6 and E7 share one E3 data
    load and one E6 run): one row per site × setting (σ, ε, α, scoring, is_default, sweeps) × metric
    (`e7Metrics`: fixes, topk_jaccard_default, e3_pool, e3_linklens@k, e3_random@k,
    e3_gain@k, e6_mrr, e6_recall@k, e6_auc), and the σ pairs' top-k Jaccard.
  - `e6.csv` (E6, needs the embedder): one row per site × repeat × method × metric
    (`e6Metrics`: recall@k, mrr, auc, queries; method `masking`: share, eligible_pairs, masked,
    targets, queries).
  - `e5.csv` / `e5_categories.csv` / `e5_disagreements.csv` (E5, each completed site with
    imported exports, under P0 and the audit's policy): `e5Metrics` (urls__, inlink__, depth__,
    orphans__, disagreements_<kind>), every category with count, share, large, explanation and
    examples, and every disagreement with its evidence (JSON).
  - `e4.csv` / `e4_pages.csv` (E4, once the re-crawl wave exists; sites completed in both):
    one row per site × comparison × metric (`e4Metrics`; comparison `pages`: days apart, the
    page classes, `site_<reason>`, `method_<reason>`, shares, discovery documents), and every
    page's class.
  - `e3.csv` (E3, the audit's policy; `export` starts the embedding worker): one row per site ×
    k × method × metric (`e3Metrics`: `total_delta_pr`, `total_delta_pr_sd` (random),
    `selected`, `targets_covered`, `sum_single_delta_pr`, `delta_pr_l1`, `newly_reachable`,
    `mean_ref`, `mean_cosine`); method `site` with an empty k: `targets_weak`,
    `targets_orphan`, `pool_*`, `*_targets_with_donors`, `target_pagerank_before`.
  - `channels.csv` (E2, the audit's policy): one row per site × channel × metric
    (`channelMetrics`: `pages_total`, `pages_exclusive`, `orphans_total`, `orphans_exclusive`,
    `orphans_exclusive_share` (left out without orphans), `inventory_without`,
    `orphans_without`; channel `all`: `inventory`, `orphans`, `orphans_several_channels`).
  - `sites.csv` (one row per site) and `stages.csv` (site × stage status and duration).
- Python: `python -m linklens_analysis corpus <batch dir> [--figures <dir>]` (`corpus.py`):
  loads and checks the CSVs, pivots, per-class summaries, Kruskal–Wallis across classes (ε²,
  Holm), Friedman across policies, and figures. `style.py` is the shared plotting style: fixed
  colour and marker per class (validated palette), an ordinal ramp for P0–P5, recessive
  chrome, sequential and diverging colour maps, PDF + PNG. matplotlib is imported only to draw.
- E1 in Python: `python -m linklens_analysis e1 <batch dir> [--stat median|mean] [--figures <dir>]`
  (`e1.py`). `class_summary`: per class (and all sites) × metric, the median over sites of
  each site's mean across its pairs, the quartiles, and the least-agreeing pair.
  `node_count_ratio` (min / max nodes) is derived there. `agreement_matrix`: the lower-
  triangular policy × policy matrix (cell (row, column) = pair (column, row), signed values
  row − column). `agreement_figure`: one heatmap per class plus all sites on a shared scale
  (sequential for agreement and magnitude, diverging around 0 for the signed depth shift;
  undefined pairs say n/a).
- Everything at once: `python analysis/make_all.py <batch dir>` with `[--out <dir>]`,
  `[--k 10]` and `[--alpha 0.05]` (or `python -m linklens_analysis make-all`). The output
  (default `<batch>/results`) has `tables/<id>.csv` and `.tex` (booktabs via `latex.py`: Unicode
  symbols as math, tables over 7 columns scaled with `\resizebox`), `figures/<id>.pdf`, `.png`
  and a `.tex` snippet, a `README.md` mapping every output to its RQ and experiment (plus the C5
  verdict), and `manifest.json` (inputs' SHA-256). Ids are `t<rq>_…` / `f<rq>_…`.
  - `RQS`: RQ0 corpus, RQ1 E1, RQ2 E2, RQ3 E3, RQ4 E4 + E5, RQ5 E6 + E7 (C5). E8 is not in a
    corpus export. `ARTIFACTS` lists every output with its RQ, experiment, title and caption.
  - An output whose data is missing (no re-crawl yet, no Screaming Frog import, no large
    category, an unknown architecture class for a class-coloured figure, no matplotlib) is
    skipped with its reason, in the README and the console, never fatal. The tables and README
    are byte-identical when re-run.
- E7 in Python: `python -m linklens_analysis e7 <batch dir> [--k 10] [--figures <dir>]`
  (`e7.py`). `ablation_table`: per σ at the default ε and α (all sites, or a class), the mean over
  sites [bootstrap 95% CI] of the top-k overlap with the default, E3 ΔPR and gain over random,
  and E6 MRR, R@10 and AUC. `sigma_pair_matrix`: the σ variants' mean pairwise top-k Jaccard.
  `curve` / `curves_figure`: per σ, a metric's mean over sites across the ε or α sweep (the
  default marked); σ colours blue, orange, aqua, violet (validated for every pair) with markers.
  `scoring_table` (L12): per σ, E3 gain under S and S_imp, their difference and S_imp's top-k
  overlap with the default. It is also `make_all`'s `t5_e7_scoring`, skipped without S_imp rows.
  An `e7.csv` without the `scoring` column (exported before L12) loads as all S.
- E6 in Python: `python -m linklens_analysis e6 <batch dir> [--alpha 0.05]` (`e6.py`). A
  site's value is the mean over its repeats. `results_table`: per class (and all sites) ×
  method, MRR, R@k and AUC as the mean over sites with a seeded bootstrap 95% CI. `paired_test`
  (the C5 refutation test): hybrid (refGateCosine) vs cosine across sites, Wilcoxon signed-rank
  one-sided (hybrid > cosine) and two-sided, zero differences dropped, rank-biserial r, Holm
  over MRR (primary), R@10 and AUC; also per class. `c5_verdict`: supported (one-sided Holm p <
  α on MRR), refuted (cosine significantly better) or not supported.
- E5 in Python: `python -m linklens_analysis e5 <batch dir>` (`e5.py`). `calibration_table`:
  per class (and all sites) × policy: sites, median URL counts, and the median [quartiles] of URL
  Jaccard, both inlink Spearmans, depth exact / ±1 / Spearman and orphan Jaccard.
  `large_categories`: every category large on at least one site, with how many, its pooled count
  and share, example sites and its explanation; the report lists each one.
- E4 in Python: `python -m linklens_analysis e4 <batch dir>` (`e4.py`). `summary_table`: per
  class (and all sites): sites, days apart, median page shares (unchanged, changed, crawled once
  for the site, for the crawl), and each metric under observed / site change only / same pages
  as "median [q1, q3]". `attribution`: the median disagreement (1 − agreement) observed, with
  only the site's changes, and on identical pages, and the site's share of the observed.
- E3 in Python: `python -m linklens_analysis e3 <batch dir> [--measure raw|relative]`
  (`e3.py`). `paired_tests`: per k, LinkLens vs each baseline across sites, Wilcoxon
  signed-rank (two-sided, zero differences dropped: a site where both choose the same fixes is
  uninformative), matched-pairs rank-biserial r = (R+ − R−) / (R+ + R−), wins/ties/losses,
  median difference, Holm over the three baselines within each k. `class_table(s)`: per class
  (and all sites) × k × method, median total ΔPR with quartiles and the paired comparison.
  `relative` divides by the targets' PageRank before (scale-free across site sizes). With n
  sites a class's smallest two-sided p is 2 / 2ⁿ (before Holm).
- E2 in Python: `python -m linklens_analysis e2 <batch dir> [--figures <dir>]` (`e2.py`).
  `class_table`: per class (and all sites) × channel, marginal pages (summed, share of the
  inventory, per-site median) and orphans detected only by the channel, pooled over the
  class's orphans and as the median site share (sites with orphans; n/a without).
  `composition`: each class's orphans split into "only by <channel>" and "several channels"
  (checked to add up). `plot_composition`: 100% stacked bars, one per class plus all sites,
  channel colours fixed in `style.CHANNEL_COLOURS` (slots 1–5, validated as adjacent pairs; a
  dark neutral for "several"), labelled segments and orphan/site counts.

### Database

- Postgres 16 + Redis 7 via `docker-compose.yml` (Postgres on host port **5433**).
- Schema changes are **new** SQL migrations only (`pnpm --filter @linklens/db migrate:create <name>`);
  never edit an applied migration.
- `link_observations`, `discovery_observations`, `fetch_bodies`, `analytics_clicks` and
  `fix_ratings` are **append-only**, enforced by
  triggers that reject UPDATE, DELETE and TRUNCATE (SQLSTATE 23001). Core exposes only insert/read
  for them.
- Every `artefacts` row has non-null `run_id` and `policy_version`.
- Integration tests create a throwaway database per run and drop it afterwards.

### Commands

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm format
pnpm services:up        # docker compose: Postgres + Redis
pnpm db:migrate         # apply migrations (reads .env)
pnpm test:integration   # DB integration tests (needs services:up)
# Python
cd analysis && python -m venv .venv && .venv/Scripts/activate && pip install -e ".[dev]" && pytest
```
