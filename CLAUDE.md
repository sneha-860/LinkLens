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
  `REF_VERSION` (`ref@1.1.0`) and the text version are stored in the payload. **Bump it whenever
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
- Order: S (highest first), then ΔPR_v, then donor, then target. `rank` is global and
  `targetRank` is within the target. `topK(fixes, k)` and `topKPerTarget(fixes, k)` return the
  top k (`fixTopK`, default 10; tested with 10, 25 and 50).
- Each record: id, donor, target, type (add-link / make-visible), ΔPR, ΔPR L1, depth
  before/after/Δ, the σ used and every variant, REF, ρ, cosine, prominence (existing ω, link
  weight before and after), κ, templateReach, score, rank, targetRank, target reasons, diagnosis
  and policy version.

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
- Fix / rescue record (`explainFix`), structured, plus six `lines` and one `sentence`:
  - `needs` (why the target), in this order:
    - orphan, with the non-link channels that revealed it ("found only via the XML sitemap");
    - deep page (depth > threshold);
    - weak authority (bottom N% by PageRank, value < threshold);
    - v4/v3, with how many pages diagnosed it.
  - `donorEvidence`: REF, the top `explainTerms` (5) matched n-grams and cosine (null for
    orphans, which are not embedded). Each n-gram keeps its `term` (Porter stems, as matched) and
    adds `words`, the surface form that the lines and sentence quote ("turtle nesting", not
    "turtl nest").
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
  - `GET /audits/:id/summary`, `/graph?policy=` (another policy is derived on demand),
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
    orphans, explanations).
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
  `/audits/:id/:tab` with the tabs summary, graph, fixes, diagnosis, orphans, canonicalisation and
  export. The live progress panel (bar + 18 stages with durations + crawl counter + resume) shows
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
  - Clicking a node opens `NodePanel`: metrics, issues with evidence, inbound and outbound links
    (region, count, anchors), and the fixes that target it. Fixes exist only under the audit's
    policy. "Preview fix" overlays the suggested edge, dashed, adding its end points if the cap
    hid them.
- Result tabs:
  - Fixes: the top k from the API, sortable client-side (`sortFixes`: score, ΔPR, Δdepth, σ, κ,
    type; a newly reachable page counts as the largest depth gain). Each row expands into an
    `ExplanationCard`.
  - Diagnosis: case count cards (they filter), a table sorted by severity, and an SVG scatter.
    ρ (or raw REF) is plotted against ω with α lines (ε when on REF), at most 3000 points,
    evenly strided.
  - Orphans: the reconciliation table (URL × six channels, a footer with totals, marginal yield
    and orphans) plus the rescue donors.
  - Canonicalisation: the sensitivity table, with a button that starts the per-policy ranking
    job. It polls while the job runs.
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

### Evaluation (packages/eval, analysis/)

- `runExperiment(db, "E1"…"E8", { runId, policy, … })` runs an experiment on a stored, audited run
  and appends an `evaluation-E<n>` artefact. The CLI is
  `pnpm --filter @linklens/eval e E3 --run 12 [--policy P3] [--out results/e3.json]`; it needs
  DATABASE_URL.
  - **E1** policy sensitivity: core `stats.compareRunPolicies`, the same as `/sensitivity`.
  - **E2** channel ablation: every subset of the five non-link channels (orphans found, recall,
    pages known), each channel alone, and leave-one-out loss.
  - **E3** fixes vs baselines: per target, among the same admissible donors, LinkLens's pick
    against REF-only, highest-PageRank, seeded random, same-section random, the home page and
    the ΔPR oracle. Mean ΔPR, share of the best ΔPR, depth gain, REF, win rate, and per-target
    picks for paired tests.
  - **E4** re-crawl stability: two runs of the same site compared in P3 form (pages, edges,
    orphans, PageRank Spearman, depth shift, top-k fixes, diagnosis case agreement). The 14-day
    re-crawl itself is a second audit run later.
  - **E5** Screaming Frog calibration: `--sf internal_all.csv`; coverage Jaccard, depth
    agreement (exact / ±1 / Spearman) and unique-inlink Spearman on HTML 200 pages.
  - **E6** hide-and-recover: a seeded sample of main-content links is hidden (every observation
    of the pair, including the donor's anchor text). Text, REF, prominence, diagnosis,
    candidates, counterfactual and scores are rebuilt in memory, and each hidden donor's rank for
    its target is found: MRR and recall@1/3/5/10.
  - **E7** σ ablation: E6 for all four σ with `candidateRequireRef: false`, so every σ ranks the
    same pool, plus the pairwise top-k Jaccard between σ rankings.
  - **E8** human rating: without `--ratings` it writes a rating sheet (CSV, top 50 fixes with
    their explanation). With the filled sheets it summarises mean relevance, would-add rate,
    top-10 vs rest, score–relevance Spearman and inter-rater agreement.
- `analysis/` (Python): `python -m linklens_analysis report results/*.json` prints Markdown
  tables. It adds paired Wilcoxon tests (E3: LinkLens vs each baseline; E7: σ pairs) and seeded
  bootstrap CIs for MRR. Its tests read fixtures written by the eval integration test with
  `LINKLENS_WRITE_FIXTURES=1`, so both sides share one shape.

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
