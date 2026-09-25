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
  /** Audit: a crawled page deeper than this many clicks from the seed is a "deep page". */
  readonly auditDeepPageDepth: number;
  /** Audit: a deep page deeper than this is high severity (else medium). */
  readonly auditDeepPageHighDepth: number;
  /** Audit: PageRank below this percentile of crawled pages (0–100) is "weak authority". */
  readonly auditWeakAuthorityPercentile: number;
  /** Audit: weak authority below this lower percentile is high severity (else medium). */
  readonly auditWeakAuthorityHighPercentile: number;
}

export const defaultConfig: Readonly<LinkLensConfig> = Object.freeze({
  pageCap: 500,
  crawlDelayMs: 500,
  userAgent: "LinkLensBot/0.1 (+contact URL)",
  epsilon: 0.2,
  refExplainTerms: 10,
  alpha: 0.1,
  frequentNgramDropPct: 0.07,
  frequentNgramMinDf: 2,
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
  counterfactualWorkers: 0,
  counterfactualValidationSample: 5,
  sigmaVariant: "refGateCosine",
  sigmaBlendLambda: 0.5,
  fixTopK: 10,
  auditDeepPageDepth: 3,
  auditDeepPageHighDepth: 6,
  auditWeakAuthorityPercentile: 20,
  auditWeakAuthorityHighPercentile: 5,
});

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
  assertUnitInterval("alpha", cfg.alpha);
  assertUnitInterval("frequentNgramDropPct", cfg.frequentNgramDropPct);
  assertPositiveInt("refExplainTerms", cfg.refExplainTerms);
  assertPositiveInt("frequentNgramMinDf", cfg.frequentNgramMinDf);
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
