import { describe, expect, it } from "vitest";
import { defaultConfig, makeConfig } from "./config.js";

describe("defaultConfig", () => {
  it("has the specified defaults", () => {
    expect(defaultConfig).toEqual({
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
      robotsMaxBytes: 512_000,
      robotsMaxRedirects: 5,
      robotsFetchTimeoutMs: 10_000,
      fetchTimeoutMs: 15_000,
      maxRedirects: 10,
      maxBodyBytes: 10_485_760,
      fetchMaxRetries: 2,
      retryBackoffMs: 1_000,
      crawlConcurrency: 1,
      includeSubdomains: false,
      maxCrawlDelayMs: 60_000,
      robotsCacheTtlMs: 86_400_000,
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
      prominenceRegionWeights: {
        body: 1.0,
        breadcrumb: 0.5,
        aside: 0.4,
        header: 0.3,
        nav: 0.3,
        pagination: 0.2,
        footer: 0.1,
      },
      prominencePositionDecay: 0.1,
      prominenceSitewideShare: 0.5,
      prominenceSitewideDiscount: 0.3,
      candidateMaxPerTarget: 30,
      candidateUtilityPatterns: [
        "(^|/)(log-?in|sign-?in|log-?out|sign-?out|register|sign-?up)([/.?]|$)",
        "(^|/)(cart|basket|checkout)([/.?]|$)",
        "(^|/)(my-?)?(account|profile)s?([/.?]|$)",
        "(^|/)search([/.?]|$)",
        "[?&](q|s|query|search)=",
        "(^|/)tags?/",
      ],
      candidateSectionBlocking: true,
      candidateSiblingSections: [],
      candidateTopLevelIsSibling: true,
      counterfactualWorkers: 0,
      counterfactualValidationSample: 5,
      sigmaVariant: "refGateCosine",
      sigmaBlendLambda: 0.5,
      fixTopK: 10,
      rescueTopK: 5,
      rescueMaxFetches: 50,
      auditDeepPageDepth: 3,
      auditDeepPageHighDepth: 6,
      auditWeakAuthorityPercentile: 20,
      auditWeakAuthorityHighPercentile: 5,
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(defaultConfig)).toBe(true);
  });
});

describe("makeConfig", () => {
  it("returns defaults when given no overrides", () => {
    expect(makeConfig()).toEqual(defaultConfig);
  });

  it("applies overrides and freezes the result", () => {
    const cfg = makeConfig({ epsilon: 0.3 });
    expect(cfg.epsilon).toBe(0.3);
    expect(cfg.pageCap).toBe(500);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it.each([
    [{ epsilon: 1.5 }],
    [{ alpha: -0.1 }],
    [{ pagerankDamping: 2 }],
    [{ pageCap: 0 }],
    [{ pageCap: 10.5 }],
    [{ crawlDelayMs: -1 }],
    [{ userAgent: " " }],
    [{ robotsMaxBytes: 1024 }],
    [{ robotsMaxRedirects: 4 }],
    [{ robotsFetchTimeoutMs: 0 }],
    [{ fetchTimeoutMs: 0 }],
    [{ maxRedirects: -1 }],
    [{ fetchMaxRetries: 1.5 }],
    [{ crawlConcurrency: 0 }],
    [{ includeSubdomains: "yes" as unknown as boolean }],
    [{ followNofollow: 1 as unknown as boolean }],
    [{ maxCrawlDelayMs: 0 }],
    [{ robotsCacheTtlMs: 25 * 60 * 60 * 1000 }],
    [{ robotsUnreachableGraceDays: 0 }],
    [{ canonicalMaxHops: 0 }],
    [{ pagerankTolerance: 0 }],
    [{ pagerankMaxIterations: 0 }],
    [{ betweennessSamples: 0 }],
    [{ discoveryMaxFetches: 0 }],
    [{ sitemapMaxDepth: -1 }],
    [{ auditDeepPageHighDepth: 2 }],
    [{ auditWeakAuthorityPercentile: 101 }],
    [{ auditWeakAuthorityHighPercentile: 30 }],
    [{ frequentNgramMinDf: 0 }],
    [{ textMinTokenLength: 0 }],
    [{ textMaxNgram: 1.5 }],
    [{ refExplainTerms: 0 }],
    [{ embeddingBodyTokens: 0 }],
    [{ embeddingBatchSize: 0 }],
    [{ embeddingDtype: "fp64" as never }],
    [{ prominencePositionDecay: -0.1 }],
    [{ candidateMaxPerTarget: 0 }],
    [{ sigmaVariant: "cosine" as never }],
    [{ sigmaBlendLambda: 1.2 }],
    [{ fixTopK: 0 }],
    [{ rescueTopK: 0 }],
    [{ rescueMaxFetches: 0 }],
    [{ counterfactualWorkers: -1 }],
    [{ counterfactualValidationSample: 1.5 }],
    [{ candidateUtilityPatterns: ["(unclosed"] }],
    [{ candidateSiblingSections: [["blog", ""]] }],
    [{ candidateSectionBlocking: "yes" as never }],
    [{ prominenceSitewideShare: 1.5 }],
    [{ prominenceSitewideDiscount: -1 }],
    [{ prominenceRegionWeights: { ...defaultConfig.prominenceRegionWeights, footer: -1 } }],
    [{ prominenceRegionWeights: { ...defaultConfig.prominenceRegionWeights, main: 1 } as never }],
    [{ prominenceRegionWeights: { body: 1 } as never }],
  ])("rejects invalid override %o", (overrides) => {
    expect(() => makeConfig(overrides)).toThrow(RangeError);
  });
});
