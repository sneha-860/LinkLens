import type { LinkLensConfig } from "@linklens/core";

/** RFC 9309 §2.2.1 product token characters: a-z, A-Z, "-", "_". */
const PRODUCT_TOKEN = /^[A-Za-z_-]+/;

/**
 * Extract the product token ("LinkLensBot" from "LinkLensBot/0.1 (+https://…)").
 * This is what robots.txt `User-agent` lines are matched against.
 */
export function productToken(userAgent: string): string {
  const token = PRODUCT_TOKEN.exec(userAgent.trim())?.[0];
  if (token === undefined) {
    throw new Error(`User-Agent "${userAgent}" does not start with an RFC 9309 product token`);
  }
  return token;
}

/**
 * Problems that stop a User-Agent being properly identifying. An empty list means it is fine.
 * A good UA has a product token, a version, and a reachable contact URL, e.g.
 * `LinkLensBot/0.1 (+https://example.org/linklens)`.
 */
export function checkUserAgent(userAgent: string): string[] {
  const problems: string[] = [];
  if (!PRODUCT_TOKEN.test(userAgent.trim())) problems.push("missing product token");
  if (!/^[A-Za-z_-]+\/\S+/.test(userAgent.trim())) problems.push("missing version (Token/x.y)");
  if (!/\(\+https?:\/\/\S+\)/.test(userAgent)) {
    problems.push("missing contact URL in the form (+https://…)");
  }
  return problems;
}

/** Headers sent with every crawler request. */
export function requestHeaders(config: Readonly<LinkLensConfig>): Record<string, string> {
  return { "User-Agent": config.userAgent };
}
