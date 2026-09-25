/**
 * The single source of truth for every LinkLens threshold and tunable.
 * No other module may hard-code these values.
 */
export interface LinkLensConfig {
  /** Maximum number of pages fetched per crawl. */
  readonly pageCap: number;
  /** Minimum delay between requests to the same host, in ms (robots.txt Crawl-delay may raise it). */
  readonly crawlDelayMs: number;
  /** User-Agent sent with every request and matched against robots.txt groups (RFC 9309). */
  readonly userAgent: string;
  /** REF cutoff ε: σ_hybrid(u,v) = cosine(u,v) if REF(u,v) > ε, else 0. */
  readonly epsilon: number;
  /** Semantic/structural blend weight α. Exact role TBD. */
  readonly alpha: number;
  /** Share of the most frequent site-wide n-grams dropped before TF-IDF (boilerplate removal). */
  readonly frequentNgramDropPct: number;
  /** Sentence-embedding model used for cosine similarity. */
  readonly embeddingModel: string;
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
}

export const defaultConfig: Readonly<LinkLensConfig> = Object.freeze({
  pageCap: 500,
  crawlDelayMs: 500,
  userAgent: "LinkLensBot/0.1 (+contact URL)",
  epsilon: 0.2,
  alpha: 0.1,
  frequentNgramDropPct: 0.07,
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
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
  if (typeof cfg.includeSubdomains !== "boolean") {
    throw new RangeError("config.includeSubdomains must be a boolean");
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
  assertUnitInterval("pagerankDamping", cfg.pagerankDamping);
  if (cfg.userAgent.trim() === "") throw new RangeError("config.userAgent must be non-empty");
  if (cfg.embeddingModel.trim() === "")
    throw new RangeError("config.embeddingModel must be non-empty");

  return Object.freeze(cfg);
}
