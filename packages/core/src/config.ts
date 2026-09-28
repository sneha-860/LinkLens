/**
 * The single source of truth for every LinkLens threshold and tunable.
 * No other module may hard-code these values.
 */
export const EMBEDDING_DTYPES = [
  "fp32",
  "fp16",
  "q8",
  "int8",
  "uint8",
  "q4",
  "bnb4",
  "q4f16",
] as const;
export type EmbeddingDtype = (typeof EMBEDDING_DTYPES)[number];

/**
 * Region classes that prominence weights links by. `body` covers dom_region main and body (and
 * a missing region, the extractor's default).
 */
export const PROMINENCE_REGIONS = [
  "body",
  "breadcrumb",
  "aside",
  "header",
  "nav",
  "pagination",
  "footer",
] as const;
export type ProminenceRegion = (typeof PROMINENCE_REGIONS)[number];

/**
 * σ(u,v) variants for fix scoring (E7 ablation): cosine only, REF only, cosine gated by REF > ε
 * (the default), and the blend λ·REF + (1 − λ)·cosine.
 */
export const SIGMA_VARIANTS = ["cosineOnly", "refOnly", "refGateCosine", "blended"] as const;
/** Page types of the page-importance estimator (L12). */
export const PAGE_TYPES = ["homepage", "hub", "product", "article", "utility", "other"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** One page type's evidence: regexes on path + query (case-insensitive), and schema.org types. */
export interface PageTypeEvidence {
  readonly url: readonly string[];
  readonly schema: readonly string[];
}

/**
 * The page-type classifier's rules (L12). First match wins: homepage (the seed), utility (URL or
 * schema), then schema.org types (product, article, hub), then URL patterns (product, hub,
 * article), then structure, else "other".
 */
export interface PageTypeRules {
  readonly utility: PageTypeEvidence;
  readonly product: PageTypeEvidence;
  readonly hub: PageTypeEvidence;
  readonly article: PageTypeEvidence;
  readonly structure: {
    /** Hub: at least this many main-content links and this share of body words in links… */
    readonly hubMinBodyLinks: number;
    readonly hubMinLinkDensity: number;
    /** …or pagination with at least this many main-content links. */
    readonly hubPaginationMinBodyLinks: number;
    /** Article: at least this many body words and at most this share of them in links. */
    readonly articleMinWords: number;
    readonly articleMaxLinkDensity: number;
  };
}

/** Fix scores: S = ΔPR × σ / κ, or S_imp = S × importance(target) (L12; experimental). */
export const FIX_SCORINGS = ["S", "S_imp"] as const;
export type FixScoring = (typeof FIX_SCORINGS)[number];

/** REF candidate generation: every pair (exact) or an LSH Ensemble containment pre-filter. */
export const REF_PREFILTERS = ["none", "lsh-ensemble"] as const;
export type RefPrefilter = (typeof REF_PREFILTERS)[number];
export type SigmaVariant = (typeof SIGMA_VARIANTS)[number];

export interface LinkLensConfig {
  /**
   * Maximum URLs admitted to a crawl's frontier (the seed included). Every admitted URL counts,
   * whatever its outcome (HTML, non-HTML, 404, robots-blocked), so the cap bounds requests.
   */
  readonly pageCap: number;
  /** Minimum delay between requests to the same host, in ms (robots.txt Crawl-delay may raise it). */
  readonly crawlDelayMs: number;
  /** User-Agent sent with every request and matched against robots.txt groups (RFC 9309). */
  readonly userAgent: string;
  /**
   * REF cutoff ε: REF(u,v) ≤ ε is set to 0 in the REF matrix (only REF > ε survives), and
   * σ_hybrid(u,v) = cosine(u,v) only where REF > ε.
   */
  readonly epsilon: number;
  /** Matched n-grams kept per REF pair as its explanation (highest target weight first). */
  readonly refExplainTerms: number;
  /**
   * REF candidate pairs: "none" scores every ordered pair exactly (default); "lsh-ensemble" scores
   * only the pairs a MinHash LSH Ensemble returns for containment of S_B in S_A (approximate:
   * a pair it misses is absent, as if REF ≤ ε).
   */
  readonly refPrefilter: RefPrefilter;
  /** LSH Ensemble: MinHash permutations per signature. */
  readonly lshNumPerm: number;
  /** LSH Ensemble: donor sets split into this many equi-depth partitions by size. */
  readonly lshPartitions: number;
  /** LSH Ensemble: most rows per band indexed (≤ lshNumPerm); bands = ⌊lshNumPerm / r⌋. */
  readonly lshMaxRows: number;
  /**
   * LSH Ensemble: containment threshold t* for |S_B ∩ S_A| / |S_B| (unweighted). Below ε by
   * default, since weighted REF can pass ε with a lower unweighted containment.
   */
  readonly lshThreshold: number;
  /** LSH Ensemble: weights of the false-positive and false-negative areas when (b, r) is tuned. */
  readonly lshFalsePositiveWeight: number;
  readonly lshFalseNegativeWeight: number;
  /** LSH experiment: page caps compared (the first N admitted URLs of one crawl at the largest). */
  readonly lshEvalCaps: readonly number[];
  /** LSH experiment: containment thresholds compared (the index is built once per cap). */
  readonly lshEvalThresholds: readonly number[];
  /** LSH experiment: timing repeats per method (the median is reported). */
  readonly lshEvalRepeats: number;
  /**
   * Diagnosis threshold α, applied to both normalised scores: a pair is semantically strong when
   * ρ(u,v) > α and its link is prominent when ω(u,v) ≥ α (see diagnosis).
   */
  readonly alpha: number;
  /**
   * Share (0–1) of the site's distinct n-grams dropped before TF-IDF, most frequent first by
   * document frequency: site-specific boilerplate removal.
   */
  readonly frequentNgramDropPct: number;
  /**
   * Only n-grams in at least this many documents may be dropped as boilerplate, so a small site
   * never loses page-unique terms to the frequentNgramDropPct quota.
   */
  readonly frequentNgramMinDf: number;
  /**
   * …and on at least this share of the documents: boilerplate is on most pages, so a topic
   * shared by a few pages is never dropped to fill the quota.
   */
  readonly frequentNgramMinDocShare: number;
  /** Tokens shorter than this (in characters, before stemming) are discarded. */
  readonly textMinTokenLength: number;
  /** Longest n-gram generated: 1 = unigrams, 2 = unigrams + bigrams, … */
  readonly textMaxNgram: number;
  /** Sentence-embedding model used for cosine similarity (a transformers.js model id). */
  readonly embeddingModel: string;
  /** ONNX weights variant of the embedding model (transformers.js `dtype`). */
  readonly embeddingDtype: EmbeddingDtype;
  /** Embedding input = Title + the first this-many model tokens of the main body. */
  readonly embeddingBodyTokens: number;
  /** Texts embedded per model call. */
  readonly embeddingBatchSize: number;
  /** PageRank damping factor. */
  readonly pagerankDamping: number;
  /** Seed for every source of randomness (determinism principle). */
  readonly randomSeed: number;
  /** Max robots.txt bytes parsed; content beyond is ignored. RFC 9309 §2.5 requires ≥ 500 KiB. */
  readonly robotsMaxBytes: number;
  /** Max consecutive robots.txt redirects followed. RFC 9309 §2.3.1.2 requires ≥ 5. */
  readonly robotsMaxRedirects: number;
  /** Timeout for a robots.txt fetch; a timeout counts as "unreachable" (complete disallow). */
  readonly robotsFetchTimeoutMs: number;
  /** Timeout for each page request (per redirect hop). A timeout is retryable. */
  readonly fetchTimeoutMs: number;
  /** Max redirect hops followed for a page before the fetch is recorded as failed. */
  readonly maxRedirects: number;
  /** Max response body bytes read; the rest is discarded (and `bytes` reflects what was read). */
  readonly maxBodyBytes: number;
  /** Retries after the first attempt, for 5xx and network/timeout errors only. */
  readonly fetchMaxRetries: number;
  /** Base delay for exponential retry backoff: base, 2×base, 4×base, … */
  readonly retryBackoffMs: number;
  /**
   * BullMQ job lock for a crawl job (ms), also the stalled-job check interval: after a crash, the
   * job that was in flight is re-queued by a resumed run once its lock expires.
   */
  readonly crawlJobLockMs: number;
  /** Jobs processed concurrently per run. 1 keeps BFS order and fetch order deterministic. */
  readonly crawlConcurrency: number;
  /** Also crawl subdomains of the seed host (seed host minus a leading "www."). */
  readonly includeSubdomains: boolean;
  /**
   * Hosts whose robots.txt Crawl-delay exceeds this are not crawled at all (fetches are recorded
   * as blocked). We never go faster than a site asks, so this bounds run time instead.
   */
  readonly maxCrawlDelayMs: number;
  /** robots.txt is refetched once its copy is older than this. RFC 9309 §2.4: ≤ 24 hours. */
  readonly robotsCacheTtlMs: number;
  /**
   * RFC 9309 §2.3.1.4: once robots.txt has been unreachable (5xx/network) for this many days,
   * it MAY be treated as unavailable (allow all). Judged from earlier runs' robots.txt fetches.
   */
  readonly robotsUnreachableGraceDays: number;
  /**
   * HTTP 429 for robots.txt: false follows RFC 9309 (4xx = unavailable = allow all); true treats it
   * as unreachable (disallow all), as Google does.
   */
  readonly robotsTreat429AsUnreachable: boolean;
  /**
   * Enqueue links with rel="nofollow" and links on pages with meta robots "nofollow". They are
   * always recorded in link_observations either way; this only affects discovery.
   */
  readonly followNofollow: boolean;
  /** Store raw bytes of 2xx HTML responses (fetch_bodies), so extraction can be re-run offline. */
  readonly storeRawHtml: boolean;
  /**
   * P5: max rel=canonical hops followed (A→B→C is 2). A longer chain is not trusted and the page
   * keeps its P4 node, as does any page in a canonical cycle (RFC 6596 §5: avoid chains).
   */
  readonly canonicalMaxHops: number;
  /** PageRank stops when the L1 change between iterations falls below this. */
  readonly pagerankTolerance: number;
  /** PageRank stops after this many iterations even if not converged (reported in the artefact). */
  readonly pagerankMaxIterations: number;
  /** Betweenness is exact up to this many nodes; above it, it is estimated from sampled sources. */
  readonly betweennessExactMaxNodes: number;
  /** Number of source nodes sampled (with randomSeed) when betweenness is estimated. */
  readonly betweennessSamples: number;
  /**
   * Max requests the discovery channels may make per run (sitemaps, feeds, HTML sitemaps,
   * llms.txt, common-path probes). Separate from pageCap, which counts crawl fetches only.
   */
  readonly discoveryMaxFetches: number;
  /** Max sitemap-index nesting followed: the first sitemap is depth 0; deeper files are skipped. */
  readonly sitemapMaxDepth: number;
  /** Max <loc> entries read from one sitemap file (the sitemaps.org protocol limit is 50,000). */
  readonly sitemapMaxUrls: number;
  /** Store the raw bytes of discovery documents (sitemaps, feeds, llms.txt) in fetch_bodies. */
  readonly storeDiscoveryBodies: boolean;
  /**
   * Prominence (the structural stand-in for the patent's session counts): weight of a link by
   * the page region it sits in. Our choice, not measured; see the limitations in CLAUDE.md.
   */
  readonly prominenceRegionWeights: Readonly<Record<ProminenceRegion, number>>;
  /** Body link at rank r (0 = first body link on the page) is weighted 1 / (1 + decay × r). */
  readonly prominencePositionDecay: number;
  /** A template block (template_signature) on more than this share of pages is site-wide… */
  readonly prominenceSitewideShare: number;
  /** …and its links are multiplied by this. */
  readonly prominenceSitewideDiscount: number;
  /** Fix candidates: at most this many donors per target, highest REF(u,v) first. */
  readonly candidateMaxPerTarget: number;
  /**
   * Fix candidates: a donor whose URL path + query matches any of these (case-insensitive
   * regular expressions) is a utility page (login, cart, account, search, tag archive) and never
   * a donor.
   */
  readonly candidateUtilityPatterns: readonly string[];
  /**
   * Fix candidates: block donors by section. A page's section is its first path segment when
   * the path has at least two segments ("/blog/post" → "blog"); shallower pages are top level.
   */
  readonly candidateSectionBlocking: boolean;
  /** Sections that may donate to each other, e.g. [["blog", "news"]]. */
  readonly candidateSiblingSections: readonly (readonly string[])[];
  /** Top-level pages (home, /about) may donate to, and receive from, any section. */
  readonly candidateTopLevelIsSibling: boolean;
  /**
   * Fix candidates must have REF(u,v) > ε. The σ ablation (E7) turns this off, so every σ
   * variant scores the same pool (otherwise cosineOnly and refGateCosine always agree).
   */
  readonly candidateRequireRef: boolean;
  /**
   * Counterfactual engine: worker threads that simulate candidates in parallel; 0 = half the
   * logical processors (about the physical cores; at least 1). Results do not depend on it.
   */
  readonly counterfactualWorkers: number;
  /** Candidates also re-run from a cold start to check the warm start (seeded by randomSeed). */
  readonly counterfactualValidationSample: number;
  /** σ variant used to score fixes (all variants are still reported on each fix). */
  readonly sigmaVariant: SigmaVariant;
  /** λ of the blended σ: λ·REF + (1 − λ)·cosine. */
  readonly sigmaBlendLambda: number;
  /** Fixes returned by default (top-k, globally and per target). */
  readonly fixTopK: number;
  /**
   * E3: the list sizes compared. Each method's top-k fixes on the weak-authority and orphan
   * targets are applied together and PageRank recomputed.
   */
  readonly e3TopKs: readonly number[];
  /** E3: draws of the random-donor baseline (seeded by randomSeed); its result is their mean. */
  readonly e3RandomDraws: number;
  /** E4: a corpus site is crawled again this many days after its first run finished. */
  readonly e4RecrawlDays: number;
  /**
   * E5: a disagreement category is "large" (and explained in the output's summary) when it holds
   * at least this share of its kind's disagreements…
   */
  readonly e5LargeShare: number;
  /** …and at least this many of them. */
  readonly e5LargeMin: number;
  /** E5: a page's inlink counts disagree when they differ by at least this many sources… */
  readonly e5InlinkMinAbsDiff: number;
  /** …and by at least this share of the larger count. */
  readonly e5InlinkMinRelDiff: number;
  /** E5: example URLs listed per disagreement category. */
  readonly e5Examples: number;
  /**
   * E6: each repeat masks a share of the site's editorial body links drawn uniformly (seeded)
   * between e6MaskShareMin and e6MaskShareMax.
   */
  readonly e6MaskShareMin: number;
  readonly e6MaskShareMax: number;
  /** E6: repeats per site, with seeds randomSeed, randomSeed + 1, … */
  readonly e6Repeats: number;
  /** E6: the k of Recall@k. */
  readonly e6Ks: readonly number[];
  /**
   * E6: also remove a masked link's anchor text from the donor's body text (the extractor keeps
   * link text in body_text, so the Links field alone would still leak the answer to REF and to
   * the embeddings).
   */
  readonly e6StripAnchorsFromBody: boolean;
  /** E6: also rank donors by Common Neighbours and Adamic–Adar on the masked link graph. */
  readonly e6GraphBaselines: boolean;
  /**
   * E7: the ε values swept (each σ variant at the default α). ε is the REF cutoff: it decides
   * which pairs are candidates and gates cosine in the hybrid σ.
   */
  readonly e7Epsilons: readonly number[];
  /** E7: the α values swept (each σ variant at the default ε). */
  readonly e7Alphas: readonly number[];
  /** Orphan rescue: donors reported per orphan (the REF shortlist ordered by ΔPR). */
  readonly rescueTopK: number;
  /**
   * Orphan rescue: max orphan pages fetched per run (their own cap: never pageCap or
   * discoveryMaxFetches).
   */
  readonly rescueMaxFetches: number;
  /** Explanations: matched n-grams quoted per fix or diagnosis (at most refExplainTerms). */
  readonly explainTerms: number;
  /**
   * Anchor suggestion: the most characters of the donor paragraph quoted around the suggested
   * anchor (cut at word boundaries, with an ellipsis).
   */
  readonly anchorExcerptChars: number;
  /** E8 rating page: the sample is drawn from the top ratingPoolSize fixes by global rank. */
  readonly ratingPoolSize: number;
  /** E8 rating page: fixes shown to the raters (≤ ratingPoolSize), in a seeded random order. */
  readonly ratingSampleSize: number;
  /** E8 rating page: precision@k at these k (by global rank, among the rated items). */
  readonly ratingKs: readonly number[];
  /** Proxy validation: bootstrap resamples (of sources, or of pages) for the Spearman CIs. */
  readonly proxyBootstrap: number;
  /** Proxy validation: a source enters the within-source Spearman with at least this many edges. */
  readonly proxyMinEdgesPerSource: number;
  /** Page importance (L12): the page-type classifier's rules. */
  readonly pageTypeRules: PageTypeRules;
  /**
   * Page importance (L12): a prior per page type, in [0, 1]. Heuristic: our judgement of how much
   * a page of that type is usually worth, not fitted to data.
   */
  readonly pageTypePriors: Readonly<Record<PageType, number>>;
  /**
   * Page importance (L12): importance(v) = Σ w_i·x_i / Σ w_i over the page-type prior, the
   * PageRank percentile, 1 / (1 + depth) and the log-scaled inbound body-link count. Heuristic
   * weights, not fitted.
   */
  readonly importanceWeights: Readonly<{
    typePrior: number;
    pagerank: number;
    depth: number;
    inboundBodyLinks: number;
  }>;
  /** The fix score: "S" (default) or "S_imp" = S × importance(target) (L12, experimental). */
  readonly fixScoring: FixScoring;
  /**
   * L13 ML prioritiser: E6 masked repeats per site used as training labels (seeds randomSeed,
   * randomSeed + 1, …; at most e6Repeats). Each costs one counterfactual per candidate pair.
   */
  readonly l13Repeats: number;
  /**
   * L13: LightGBM lambdarank parameters, by LightGBM's own names (num_boost_round is the number
   * of trees). Heuristic defaults for small data, not tuned on the evaluation sites.
   */
  readonly l13Lightgbm: Readonly<Record<string, number>>;
  /** L13: the largest SHAP contributions shown per fix. */
  readonly l13ShapTop: number;
  /**
   * GraphSAGE link predictor (experimental, off by default). When on, E6 adds the "graphsage"
   * method from the run's latest graphsage-scores artefact (trained offline in analysis/ml,
   * leave-one-site-out), and the L13 ranker adds its score as a feature.
   */
  readonly graphsageEnabled: boolean;
  /**
   * GraphSAGE training (PyTorch Geometric): layers (mean aggregator), hidden width, epochs,
   * learning rate, weight decay, dropout, negatives per positive edge, and the share of a
   * graph's edges held out of message passing as supervision in each epoch. Heuristic defaults
   * for graphs of a few hundred pages, not tuned on the evaluation sites.
   */
  readonly graphsage: Readonly<Record<string, number>>;
  /**
   * Link health: a link target reached through at least this many redirect hops is reported as
   * a redirect chain (2 = longer than one hop).
   */
  readonly linkHealthMinChainHops: number;
  /** Audit: a crawled page deeper than this many clicks from the seed is a "deep page". */
  readonly auditDeepPageDepth: number;
  /** Audit: a deep page deeper than this is high severity (else medium). */
  readonly auditDeepPageHighDepth: number;
  /** Audit: PageRank below this percentile of crawled pages (0–100) is "weak authority". */
  readonly auditWeakAuthorityPercentile: number;
  /** Audit: weak authority below this lower percentile is high severity (else medium). */
  readonly auditWeakAuthorityHighPercentile: number;
  /** API: audits (and policy jobs) running at once per API process; more are refused with 429. */
  readonly apiMaxConcurrentAudits: number;
  /**
   * API: an instance running an audit holds a lease in Redis for this long, renewed every third
   * of it. Other instances see the audit as active while the lease lives, and resume it (after a
   * crash) only once it has expired.
   */
  readonly apiAuditLeaseMs: number;
  /**
   * API: worker threads for the CPU-heavy stages (graph to explanations, except the embeddings
   * and the counterfactual, which have their own workers); 0 = run them on the main thread.
   */
  readonly apiStageWorkers: number;
}

export const defaultConfig: Readonly<LinkLensConfig> = Object.freeze({
  pageCap: 500,
  crawlDelayMs: 500,
  userAgent: "LinkLensBot/0.1 (+https://github.com/sneha-860/LinkLens)",
  epsilon: 0.2,
  refExplainTerms: 10,
  refPrefilter: "none",
  lshNumPerm: 128,
  lshPartitions: 16,
  lshMaxRows: 16,
  lshThreshold: 0.1,
  lshFalsePositiveWeight: 0.5,
  lshFalseNegativeWeight: 0.5,
  lshEvalCaps: Object.freeze([500, 1000, 2000]),
  lshEvalThresholds: Object.freeze([0.05, 0.1, 0.2]),
  lshEvalRepeats: 3,
  alpha: 0.1,
  frequentNgramDropPct: 0.07,
  frequentNgramMinDf: 2,
  frequentNgramMinDocShare: 0.5,
  textMinTokenLength: 2,
  textMaxNgram: 2,
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  embeddingDtype: "fp32",
  embeddingBodyTokens: 256,
  embeddingBatchSize: 16,
  pagerankDamping: 0.85,
  randomSeed: 42,
  robotsMaxBytes: 500 * 1024,
  robotsMaxRedirects: 5,
  robotsFetchTimeoutMs: 10_000,
  fetchTimeoutMs: 15_000,
  maxRedirects: 10,
  maxBodyBytes: 10 * 1024 * 1024,
  fetchMaxRetries: 2,
  retryBackoffMs: 1_000,
  crawlJobLockMs: 30_000,
  crawlConcurrency: 1,
  includeSubdomains: false,
  maxCrawlDelayMs: 60_000,
  robotsCacheTtlMs: 24 * 60 * 60 * 1000,
  robotsUnreachableGraceDays: 30,
  robotsTreat429AsUnreachable: false,
  followNofollow: true,
  storeRawHtml: true,
  canonicalMaxHops: 3,
  pagerankTolerance: 1e-10,
  pagerankMaxIterations: 1_000,
  betweennessExactMaxNodes: 300,
  betweennessSamples: 100,
  discoveryMaxFetches: 100,
  sitemapMaxDepth: 3,
  sitemapMaxUrls: 50_000,
  storeDiscoveryBodies: true,
  prominenceRegionWeights: Object.freeze({
    body: 1.0,
    breadcrumb: 0.5,
    aside: 0.4,
    header: 0.3,
    nav: 0.3,
    pagination: 0.2,
    footer: 0.1,
  }),
  prominencePositionDecay: 0.1,
  prominenceSitewideShare: 0.5,
  prominenceSitewideDiscount: 0.3,
  candidateMaxPerTarget: 30,
  candidateUtilityPatterns: Object.freeze([
    "(^|/)(log-?in|sign-?in|log-?out|sign-?out|register|sign-?up)([/.?]|$)",
    "(^|/)(cart|basket|checkout)([/.?]|$)",
    "(^|/)(my-?)?(account|profile)s?([/.?]|$)",
    "(^|/)search([/.?]|$)",
    "[?&](q|s|query|search)=",
    "(^|/)tags?/",
  ]),
  candidateSectionBlocking: true,
  candidateSiblingSections: Object.freeze([]),
  candidateTopLevelIsSibling: true,
  candidateRequireRef: true,
  counterfactualWorkers: 0,
  counterfactualValidationSample: 5,
  sigmaVariant: "refGateCosine",
  sigmaBlendLambda: 0.5,
  fixTopK: 10,
  e3TopKs: Object.freeze([10, 25, 50]),
  e3RandomDraws: 20,
  e4RecrawlDays: 14,
  e5LargeShare: 0.1,
  e5LargeMin: 3,
  e5InlinkMinAbsDiff: 2,
  e5InlinkMinRelDiff: 0.5,
  e5Examples: 3,
  e6MaskShareMin: 0.1,
  e6MaskShareMax: 0.2,
  e6Repeats: 5,
  e6Ks: Object.freeze([5, 10, 20]),
  e6StripAnchorsFromBody: true,
  e6GraphBaselines: true,
  e7Epsilons: Object.freeze([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]),
  e7Alphas: Object.freeze([0.05, 0.1, 0.15, 0.2, 0.25, 0.3]),
  rescueTopK: 5,
  rescueMaxFetches: 50,
  explainTerms: 5,
  anchorExcerptChars: 240,
  ratingPoolSize: 50,
  ratingSampleSize: 50,
  ratingKs: Object.freeze([5, 10, 25, 50]),
  proxyBootstrap: 2000,
  proxyMinEdgesPerSource: 3,
  linkHealthMinChainHops: 2,
  pageTypeRules: Object.freeze({
    utility: Object.freeze({
      url: Object.freeze([
        "(^|/)(log-?in|sign-?in|log-?out|sign-?out|register|sign-?up)([/.?]|$)",
        "(^|/)(cart|basket|checkout|wishlist)([/.?]|$)",
        "(^|/)(my-?)?(account|profile)s?([/.?]|$)",
        "(^|/)search([/.?]|$)",
        "[?&](q|s|query|search)=",
        "(^|/)tags?/",
        "[?&]route=(account|checkout)/",
      ]),
      schema: Object.freeze(["SearchResultsPage", "CheckoutPage"]),
    }),
    product: Object.freeze({
      url: Object.freeze([
        "(^|/)(products?|items?|p|dp)/[^/?#]+",
        "[?&]route=product/product",
        "[?&](product_id|productid|pid)=",
      ]),
      schema: Object.freeze([
        "Product",
        "ProductGroup",
        "ProductModel",
        "IndividualProduct",
        "Offer",
        "AggregateOffer",
      ]),
    }),
    hub: Object.freeze({
      url: Object.freeze([
        "(^|/)(categor(y|ies)|collections?|archives?|topics?|sections?|departments?)(/|$)",
        "(^|/)page/\\d+/?$",
        "[?&]route=product/category",
        "^/?(blog|news|docs?|shop|catalog(ue)?|guides?)/?$",
      ]),
      schema: Object.freeze(["CollectionPage", "ItemList", "OfferCatalog", "Blog"]),
    }),
    article: Object.freeze({
      url: Object.freeze([
        "(^|/)(blog|news|posts?|articles?|stories)/[^?#]+",
        "(^|/)\\d{4}/\\d{2}/",
        "(^|/)(docs?|documentation|guides?|manual|reference|tutorials?|learn|api)/[^?#]+",
      ]),
      schema: Object.freeze([
        "Article",
        "BlogPosting",
        "NewsArticle",
        "TechArticle",
        "APIReference",
        "Report",
        "ScholarlyArticle",
        "HowTo",
        "Recipe",
        "FAQPage",
        "QAPage",
        "DiscussionForumPosting",
        "LiveBlogPosting",
      ]),
    }),
    structure: Object.freeze({
      hubMinBodyLinks: 20,
      hubMinLinkDensity: 0.35,
      hubPaginationMinBodyLinks: 5,
      articleMinWords: 300,
      articleMaxLinkDensity: 0.15,
    }),
  }),
  pageTypePriors: Object.freeze({
    homepage: 1,
    product: 0.8,
    hub: 0.7,
    article: 0.6,
    other: 0.4,
    utility: 0.05,
  }),
  importanceWeights: Object.freeze({
    typePrior: 0.4,
    pagerank: 0.25,
    depth: 0.2,
    inboundBodyLinks: 0.15,
  }),
  fixScoring: "S",
  l13Repeats: 2,
  l13Lightgbm: Object.freeze({
    num_boost_round: 300,
    learning_rate: 0.05,
    num_leaves: 15,
    min_data_in_leaf: 20,
    feature_fraction: 0.8,
    bagging_fraction: 0.8,
    bagging_freq: 1,
    lambda_l2: 1,
  }),
  l13ShapTop: 3,
  graphsageEnabled: false,
  graphsage: Object.freeze({
    layers: 2,
    hidden: 64,
    epochs: 200,
    learning_rate: 0.01,
    weight_decay: 0.0005,
    dropout: 0.2,
    negative_ratio: 1,
    supervision_share: 0.3,
  }),
  auditDeepPageDepth: 3,
  auditDeepPageHighDepth: 6,
  auditWeakAuthorityPercentile: 20,
  auditWeakAuthorityHighPercentile: 5,
  apiMaxConcurrentAudits: 2,
  apiAuditLeaseMs: 30_000,
  apiStageWorkers: 2,
});

function validatePageTypeRules(rules: PageTypeRules): void {
  for (const t of ["utility", "product", "hub", "article"] as const) {
    const e = rules?.[t];
    if (!Array.isArray(e?.url) || !Array.isArray(e?.schema)) {
      throw new RangeError(`config.pageTypeRules.${t} needs url and schema lists`);
    }
    for (const p of e.url) {
      try {
        new RegExp(p, "i");
      } catch {
        throw new RangeError(`config.pageTypeRules.${t}.url: invalid regex ${p}`);
      }
    }
  }
  const s = rules.structure;
  const ints = [s?.hubMinBodyLinks, s?.hubPaginationMinBodyLinks, s?.articleMinWords];
  const shares = [s?.hubMinLinkDensity, s?.articleMaxLinkDensity];
  if (!ints.every((x) => Number.isInteger(x) && (x as number) >= 0)) {
    throw new RangeError("config.pageTypeRules.structure: counts must be non-negative integers");
  }
  if (!shares.every((x) => typeof x === "number" && x >= 0 && x <= 1)) {
    throw new RangeError("config.pageTypeRules.structure: densities must be in [0, 1]");
  }
}

function assertUnitInterval(name: keyof LinkLensConfig, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`config.${name} must be in [0, 1], got ${value}`);
  }
}

function assertPositiveInt(name: keyof LinkLensConfig, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`config.${name} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeInt(name: keyof LinkLensConfig, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`config.${name} must be a non-negative integer, got ${value}`);
  }
}

/** Merge overrides onto the defaults, validate, and freeze. */
export function makeConfig(overrides: Partial<LinkLensConfig> = {}): Readonly<LinkLensConfig> {
  const cfg: LinkLensConfig = { ...defaultConfig, ...overrides };

  assertPositiveInt("pageCap", cfg.pageCap);
  assertNonNegativeInt("crawlDelayMs", cfg.crawlDelayMs);
  assertNonNegativeInt("randomSeed", cfg.randomSeed);
  assertPositiveInt("robotsFetchTimeoutMs", cfg.robotsFetchTimeoutMs);
  assertPositiveInt("fetchTimeoutMs", cfg.fetchTimeoutMs);
  assertNonNegativeInt("maxRedirects", cfg.maxRedirects);
  assertPositiveInt("maxBodyBytes", cfg.maxBodyBytes);
  assertNonNegativeInt("fetchMaxRetries", cfg.fetchMaxRetries);
  assertNonNegativeInt("retryBackoffMs", cfg.retryBackoffMs);
  assertPositiveInt("crawlConcurrency", cfg.crawlConcurrency);
  assertPositiveInt("crawlJobLockMs", cfg.crawlJobLockMs);
  assertPositiveInt("apiMaxConcurrentAudits", cfg.apiMaxConcurrentAudits);
  assertPositiveInt("apiAuditLeaseMs", cfg.apiAuditLeaseMs);
  assertNonNegativeInt("apiStageWorkers", cfg.apiStageWorkers);
  assertPositiveInt("maxCrawlDelayMs", cfg.maxCrawlDelayMs);
  assertPositiveInt("robotsCacheTtlMs", cfg.robotsCacheTtlMs);
  if (cfg.robotsCacheTtlMs > 24 * 60 * 60 * 1000) {
    throw new RangeError("config.robotsCacheTtlMs must be ≤ 24 hours (RFC 9309 §2.4)");
  }
  assertPositiveInt("robotsUnreachableGraceDays", cfg.robotsUnreachableGraceDays);
  assertPositiveInt("canonicalMaxHops", cfg.canonicalMaxHops);
  if (!(cfg.pagerankTolerance > 0 && cfg.pagerankTolerance < 1)) {
    throw new RangeError("config.pagerankTolerance must be in (0, 1)");
  }
  assertPositiveInt("pagerankMaxIterations", cfg.pagerankMaxIterations);
  assertPositiveInt("betweennessExactMaxNodes", cfg.betweennessExactMaxNodes);
  assertPositiveInt("betweennessSamples", cfg.betweennessSamples);
  assertPositiveInt("discoveryMaxFetches", cfg.discoveryMaxFetches);
  assertNonNegativeInt("sitemapMaxDepth", cfg.sitemapMaxDepth);
  assertPositiveInt("sitemapMaxUrls", cfg.sitemapMaxUrls);
  assertPositiveInt("candidateMaxPerTarget", cfg.candidateMaxPerTarget);
  if (!Array.isArray(cfg.candidateUtilityPatterns)) {
    throw new RangeError("config.candidateUtilityPatterns must be an array of regular expressions");
  }
  for (const p of cfg.candidateUtilityPatterns) {
    try {
      new RegExp(p, "i");
    } catch {
      throw new RangeError(`config.candidateUtilityPatterns: invalid regular expression ${p}`);
    }
  }
  if (
    !Array.isArray(cfg.candidateSiblingSections) ||
    !cfg.candidateSiblingSections.every(
      (g) => Array.isArray(g) && g.every((x) => typeof x === "string" && x !== ""),
    )
  ) {
    throw new RangeError("config.candidateSiblingSections must be an array of section-name arrays");
  }
  assertNonNegativeInt("counterfactualWorkers", cfg.counterfactualWorkers);
  assertNonNegativeInt("counterfactualValidationSample", cfg.counterfactualValidationSample);
  if (!SIGMA_VARIANTS.includes(cfg.sigmaVariant)) {
    throw new RangeError(`config.sigmaVariant must be one of ${SIGMA_VARIANTS.join(", ")}`);
  }
  assertUnitInterval("sigmaBlendLambda", cfg.sigmaBlendLambda);
  assertPositiveInt("fixTopK", cfg.fixTopK);
  if (
    !Array.isArray(cfg.e3TopKs) ||
    cfg.e3TopKs.length === 0 ||
    !cfg.e3TopKs.every((k) => Number.isInteger(k) && k > 0) ||
    new Set(cfg.e3TopKs).size !== cfg.e3TopKs.length
  ) {
    throw new RangeError("config.e3TopKs must be distinct positive integers");
  }
  assertPositiveInt("e3RandomDraws", cfg.e3RandomDraws);
  assertPositiveInt("e4RecrawlDays", cfg.e4RecrawlDays);
  assertUnitInterval("e5LargeShare", cfg.e5LargeShare);
  assertPositiveInt("e5LargeMin", cfg.e5LargeMin);
  assertPositiveInt("e5InlinkMinAbsDiff", cfg.e5InlinkMinAbsDiff);
  assertUnitInterval("e5InlinkMinRelDiff", cfg.e5InlinkMinRelDiff);
  assertNonNegativeInt("e5Examples", cfg.e5Examples);
  assertUnitInterval("e6MaskShareMin", cfg.e6MaskShareMin);
  assertUnitInterval("e6MaskShareMax", cfg.e6MaskShareMax);
  if (cfg.e6MaskShareMin > cfg.e6MaskShareMax) {
    throw new RangeError("config.e6MaskShareMin must be ≤ e6MaskShareMax");
  }
  assertPositiveInt("e6Repeats", cfg.e6Repeats);
  if (
    !Array.isArray(cfg.e6Ks) ||
    cfg.e6Ks.length === 0 ||
    !cfg.e6Ks.every((k) => Number.isInteger(k) && k > 0)
  ) {
    throw new RangeError("config.e6Ks must be positive integers");
  }
  for (const key of ["e7Epsilons", "e7Alphas"] as const) {
    const xs = cfg[key];
    if (
      !Array.isArray(xs) ||
      xs.length === 0 ||
      !xs.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) ||
      new Set(xs).size !== xs.length
    ) {
      throw new RangeError(`config.${key} must be distinct values in [0, 1]`);
    }
  }
  assertPositiveInt("rescueTopK", cfg.rescueTopK);
  assertPositiveInt("rescueMaxFetches", cfg.rescueMaxFetches);
  assertPositiveInt("explainTerms", cfg.explainTerms);
  if (cfg.explainTerms > cfg.refExplainTerms) {
    throw new RangeError("config.explainTerms must be ≤ refExplainTerms (only those are stored)");
  }
  assertPositiveInt("anchorExcerptChars", cfg.anchorExcerptChars);
  assertPositiveInt("ratingPoolSize", cfg.ratingPoolSize);
  assertPositiveInt("ratingSampleSize", cfg.ratingSampleSize);
  if (cfg.ratingSampleSize > cfg.ratingPoolSize) {
    throw new RangeError("config.ratingSampleSize must be ≤ ratingPoolSize");
  }
  if (
    !Array.isArray(cfg.ratingKs) ||
    cfg.ratingKs.length === 0 ||
    !cfg.ratingKs.every((k) => Number.isInteger(k) && k > 0)
  ) {
    throw new RangeError("config.ratingKs must be positive integers");
  }
  assertPositiveInt("proxyBootstrap", cfg.proxyBootstrap);
  assertPositiveInt("proxyMinEdgesPerSource", cfg.proxyMinEdgesPerSource);
  assertPositiveInt("linkHealthMinChainHops", cfg.linkHealthMinChainHops);
  validatePageTypeRules(cfg.pageTypeRules);
  for (const t of PAGE_TYPES) {
    const p = cfg.pageTypePriors?.[t];
    if (typeof p !== "number" || !(p >= 0 && p <= 1)) {
      throw new RangeError(`config.pageTypePriors.${t} must be in [0, 1]`);
    }
  }
  const w = cfg.importanceWeights;
  const ws = [w?.typePrior, w?.pagerank, w?.depth, w?.inboundBodyLinks];
  if (
    !ws.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0) ||
    ws.reduce((a, b) => (a as number) + (b as number), 0) === 0
  ) {
    throw new RangeError("config.importanceWeights must be non-negative numbers, not all 0");
  }
  assertPositiveInt("l13Repeats", cfg.l13Repeats);
  if (cfg.l13Repeats > cfg.e6Repeats) {
    throw new RangeError("config.l13Repeats must be ≤ e6Repeats");
  }
  if (
    cfg.l13Lightgbm === null ||
    typeof cfg.l13Lightgbm !== "object" ||
    !Object.values(cfg.l13Lightgbm).every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new RangeError("config.l13Lightgbm must map LightGBM parameter names to numbers");
  }
  assertPositiveInt("l13ShapTop", cfg.l13ShapTop);
  if (typeof cfg.graphsageEnabled !== "boolean") {
    throw new RangeError("config.graphsageEnabled must be a boolean");
  }
  {
    const g = cfg.graphsage;
    const num = (k: string) => (g as Record<string, unknown>)?.[k];
    const ok =
      g !== null &&
      typeof g === "object" &&
      Object.values(g).every((v) => typeof v === "number" && Number.isFinite(v)) &&
      ["layers", "hidden", "epochs", "negative_ratio"].every(
        (k) => Number.isInteger(num(k)) && (num(k) as number) >= 1,
      ) &&
      (num("learning_rate") as number) > 0 &&
      (num("supervision_share") as number) > 0 &&
      (num("supervision_share") as number) < 1 &&
      (num("dropout") as number) >= 0 &&
      (num("dropout") as number) < 1;
    if (!ok) {
      throw new RangeError(
        "config.graphsage needs integer layers, hidden, epochs, negative_ratio ≥ 1, learning_rate > 0, dropout in [0, 1) and supervision_share in (0, 1)",
      );
    }
  }
  if (!FIX_SCORINGS.includes(cfg.fixScoring)) {
    throw new RangeError(`config.fixScoring must be one of ${FIX_SCORINGS.join(", ")}`);
  }
  assertNonNegativeInt("auditDeepPageDepth", cfg.auditDeepPageDepth);
  if (
    !Number.isInteger(cfg.auditDeepPageHighDepth) ||
    cfg.auditDeepPageHighDepth < cfg.auditDeepPageDepth
  ) {
    throw new RangeError("config.auditDeepPageHighDepth must be an integer ≥ auditDeepPageDepth");
  }
  for (const k of ["auditWeakAuthorityPercentile", "auditWeakAuthorityHighPercentile"] as const) {
    if (!(cfg[k] >= 0 && cfg[k] <= 100)) throw new RangeError(`config.${k} must be in [0, 100]`);
  }
  if (cfg.auditWeakAuthorityHighPercentile > cfg.auditWeakAuthorityPercentile) {
    throw new RangeError(
      "config.auditWeakAuthorityHighPercentile must be ≤ auditWeakAuthorityPercentile",
    );
  }
  for (const flag of [
    "includeSubdomains",
    "robotsTreat429AsUnreachable",
    "followNofollow",
    "storeRawHtml",
    "storeDiscoveryBodies",
    "candidateSectionBlocking",
    "candidateTopLevelIsSibling",
    "candidateRequireRef",
  ] as const) {
    if (typeof cfg[flag] !== "boolean") throw new RangeError(`config.${flag} must be a boolean`);
  }
  if (!Number.isInteger(cfg.robotsMaxBytes) || cfg.robotsMaxBytes < 500 * 1024) {
    throw new RangeError(`config.robotsMaxBytes must be an integer ≥ 500 KiB (RFC 9309 §2.5)`);
  }
  if (!Number.isInteger(cfg.robotsMaxRedirects) || cfg.robotsMaxRedirects < 5) {
    throw new RangeError(`config.robotsMaxRedirects must be an integer ≥ 5 (RFC 9309 §2.3.1.2)`);
  }
  assertUnitInterval("epsilon", cfg.epsilon);
  if (!REF_PREFILTERS.includes(cfg.refPrefilter)) {
    throw new RangeError(`config.refPrefilter must be one of ${REF_PREFILTERS.join(", ")}`);
  }
  assertPositiveInt("lshNumPerm", cfg.lshNumPerm);
  assertPositiveInt("lshPartitions", cfg.lshPartitions);
  assertPositiveInt("lshMaxRows", cfg.lshMaxRows);
  if (cfg.lshMaxRows > cfg.lshNumPerm) {
    throw new RangeError("config.lshMaxRows must be ≤ lshNumPerm");
  }
  if (!(cfg.lshThreshold > 0 && cfg.lshThreshold <= 1)) {
    throw new RangeError("config.lshThreshold must be in (0, 1]");
  }
  assertUnitInterval("lshFalsePositiveWeight", cfg.lshFalsePositiveWeight);
  assertUnitInterval("lshFalseNegativeWeight", cfg.lshFalseNegativeWeight);
  if (cfg.lshFalsePositiveWeight + cfg.lshFalseNegativeWeight <= 0) {
    throw new RangeError("config.lshFalsePositiveWeight + lshFalseNegativeWeight must be > 0");
  }
  if (
    !Array.isArray(cfg.lshEvalCaps) ||
    cfg.lshEvalCaps.length === 0 ||
    !cfg.lshEvalCaps.every((c) => Number.isInteger(c) && c > 1) ||
    new Set(cfg.lshEvalCaps).size !== cfg.lshEvalCaps.length
  ) {
    throw new RangeError("config.lshEvalCaps must be distinct integers > 1");
  }
  if (
    !Array.isArray(cfg.lshEvalThresholds) ||
    cfg.lshEvalThresholds.length === 0 ||
    !cfg.lshEvalThresholds.every((t) => Number.isFinite(t) && t > 0 && t <= 1) ||
    new Set(cfg.lshEvalThresholds).size !== cfg.lshEvalThresholds.length
  ) {
    throw new RangeError("config.lshEvalThresholds must be distinct values in (0, 1]");
  }
  assertPositiveInt("lshEvalRepeats", cfg.lshEvalRepeats);
  assertUnitInterval("alpha", cfg.alpha);
  assertUnitInterval("frequentNgramDropPct", cfg.frequentNgramDropPct);
  assertPositiveInt("refExplainTerms", cfg.refExplainTerms);
  assertPositiveInt("frequentNgramMinDf", cfg.frequentNgramMinDf);
  assertUnitInterval("frequentNgramMinDocShare", cfg.frequentNgramMinDocShare);
  assertPositiveInt("textMinTokenLength", cfg.textMinTokenLength);
  assertPositiveInt("textMaxNgram", cfg.textMaxNgram);
  assertUnitInterval("pagerankDamping", cfg.pagerankDamping);
  const weights = cfg.prominenceRegionWeights as Record<string, unknown>;
  const keys = Object.keys(weights).sort();
  if (keys.join() !== [...PROMINENCE_REGIONS].sort().join()) {
    throw new RangeError(
      `config.prominenceRegionWeights must have exactly the keys ${PROMINENCE_REGIONS.join(", ")}`,
    );
  }
  for (const k of keys) {
    const w = weights[k];
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0) {
      throw new RangeError(`config.prominenceRegionWeights.${k} must be a finite number ≥ 0`);
    }
  }
  if (!(Number.isFinite(cfg.prominencePositionDecay) && cfg.prominencePositionDecay >= 0)) {
    throw new RangeError("config.prominencePositionDecay must be a finite number ≥ 0");
  }
  assertUnitInterval("prominenceSitewideShare", cfg.prominenceSitewideShare);
  assertUnitInterval("prominenceSitewideDiscount", cfg.prominenceSitewideDiscount);
  if (cfg.userAgent.trim() === "") throw new RangeError("config.userAgent must be non-empty");
  assertPositiveInt("embeddingBodyTokens", cfg.embeddingBodyTokens);
  assertPositiveInt("embeddingBatchSize", cfg.embeddingBatchSize);
  if (!EMBEDDING_DTYPES.includes(cfg.embeddingDtype)) {
    throw new RangeError(`config.embeddingDtype must be one of ${EMBEDDING_DTYPES.join(", ")}`);
  }
  if (cfg.embeddingModel.trim() === "")
    throw new RangeError("config.embeddingModel must be non-empty");

  return Object.freeze(cfg);
}
