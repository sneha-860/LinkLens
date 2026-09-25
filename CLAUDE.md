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

| Label | Meaning              |
| ----- | -------------------- |
| v4    | missing              |
| v3    | buried               |
| v2    | good                 |
| v1    | misleading/low-value |

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
- `packages/api`: Express HTTP API.
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
- `template_signature`: 16 hex chars of SHA-1 over the ancestor chain (tag, digit-free id,
  structural classes). Positions, digits and state classes (active/current/is-*) are dropped, so the
  same block matches across pages.
- `body_text` and `paragraphs` (`<p>` and `<li>`) come from `<main>`/`[role=main]`, else `<body>`,
  with nav/header/footer/aside/breadcrumb/pagination stripped.
- 5xx, network errors and timeouts are retried up to `fetchMaxRetries` times with exponential
  backoff. 4xx is never retried.
- `pageCap` counts every admitted URL, whatever its outcome.
- `cancel()` aborts the in-flight request, closes the worker, obliterates the queue, clears the
  frontier keys and sets the run to `cancelled`.
- `detach()` / `CrawlOrchestrator.shutdown()` stop the worker but keep the Redis state; the run stays
  `running`. `resume(runId)` continues it, and marks it `failed` if the Redis state is gone. Jobs
  in flight in a crashed process are re-queued by BullMQ's stalled-job check.
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
  term), but only n-grams in at least `frequentNgramMinDf` documents.
- TF-IDF per field: tf is the raw count; idf = `ln((1+N)/(1+df)) + 1`.
- Views: donor `S_A = Links ∪ Body` and target `S_B = Title ∪ Body` (B's own anchors are
  excluded). Each is stored as a sorted term set. `viewWeights` sums the field weights.

### REF matrix (packages/core/src/semantic)

- `buildRefRun(db, runId, policyId, variant)` builds the text model in memory (`loadTextModel`,
  with the run's stored config) and appends a `ref-matrix` artefact. The pure core is `refMatrix`.
  `REF_VERSION` (`ref@1.0.0`) and the text version are stored in the payload. **Bump it whenever
  the output can change.**
- Variants: `weighted` (default; `w_B` = the target view's summed field TF-IDF weights) and
  `unweighted`. `ref()` computes one pair.
- All ordered pairs u ≠ v, computed exactly but through an inverted index (CSR postings over
  interned term ids), so a donor only touches targets it shares a term with.
- ε cutoff: REF below `config.epsilon` is set to 0 and not stored (REF = ε is kept). The matrix
  is sparse (COO, node indices, sorted by source then target); self-pairs are never stored.
- Per-node normalisation: `ρ(u,v) = REF(u,v) / Σ_w REF(u,w)` over u's stored entries, so each
  source's ρ sums to 1.
- Each stored pair keeps `matchedCount` and its `refExplainTerms` matched n-grams with the
  largest contribution (`w_B(t) / Σ w_B`, or `1/|S_B|` unweighted; ties by term), for explanations.
- Runtime at 500 pages (249,500 pairs): see `src/semantic/ref.bench.ts`. It is under 1 s even
  when every pair shares terms. A very low ε on a dense site stores every pair with an
  explanation (hundreds of MB), which is why ε matters.

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

### Database

- Postgres 16 + Redis 7 via `docker-compose.yml` (Postgres on host port **5433**).
- Schema changes are **new** SQL migrations only (`pnpm --filter @linklens/db migrate:create <name>`);
  never edit an applied migration.
- `link_observations`, `discovery_observations`, `fetch_bodies` and `analytics_clicks` are
  **append-only**, enforced by
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
