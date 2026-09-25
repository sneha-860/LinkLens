/**
 * robots.txt parser following RFC 9309 §2.1–2.2.
 *
 * - Records are `key: value`, keys case-insensitive, `#` starts a comment.
 * - A group is one or more consecutive `user-agent` lines followed by rules. A `user-agent` line
 *   after a rule starts a new group. Blank lines do not end a group.
 * - Rules before the first `user-agent` line are ignored.
 * - `sitemap` lines are global (not tied to any group) and do not affect grouping.
 * - `crawl-delay` is non-standard but widely used; it attaches to the current group.
 * - Unknown keys are ignored.
 * - Values are kept raw (only surrounding whitespace is trimmed).
 */

export type RuleType = "allow" | "disallow";

export interface RobotsRule {
  readonly type: RuleType;
  /** Raw pattern as written in the file. */
  readonly pattern: string;
  /** 1-based line number, for provenance and explanations. */
  readonly line: number;
}

export interface RobotsGroup {
  /** Raw user-agent values of the group, as written. */
  readonly userAgents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /** Crawl-delay in seconds, or null if absent/invalid. The last valid value in the group wins. */
  readonly crawlDelaySeconds: number | null;
}

export interface SitemapDirective {
  /** Raw value as written; resolving/validating it is the discovery layer's job. */
  readonly url: string;
  readonly line: number;
}

export interface ParsedRobots {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly SitemapDirective[];
  /** True if the input exceeded the byte limit and the tail was ignored. */
  readonly truncated: boolean;
}

interface MutableGroup {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

/** Parse a non-negative decimal number of seconds, else null. */
function parseCrawlDelay(value: string): number | null {
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decode robots.txt bytes as UTF-8, keeping at most `maxBytes`. If truncated, the trailing
 * partial line is dropped so a half-written rule is never parsed.
 */
export function decodeRobots(
  bytes: Uint8Array,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const truncated = bytes.length > maxBytes;
  let text = new TextDecoder("utf-8", { fatal: false }).decode(
    truncated ? bytes.subarray(0, maxBytes) : bytes,
  );
  if (truncated) {
    const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    text = lastBreak === -1 ? "" : text.slice(0, lastBreak);
  }
  return { text, truncated };
}

export function parseRobots(text: string, truncated = false): ParsedRobots {
  const groups: MutableGroup[] = [];
  const sitemaps: SitemapDirective[] = [];
  let current: MutableGroup | null = null;
  let lastWasUserAgent = false;

  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const hash = rawLine.indexOf("#");
    const content = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    if (content === "") return;

    const colon = content.indexOf(":");
    if (colon === -1) return; // not a record
    const key = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();

    switch (key) {
      case "user-agent": {
        if (current === null || !lastWasUserAgent) {
          current = { userAgents: [], rules: [], crawlDelaySeconds: null };
          groups.push(current);
        }
        current.userAgents.push(value);
        lastWasUserAgent = true;
        return;
      }
      case "allow":
      case "disallow": {
        lastWasUserAgent = false;
        // Empty value means "no rule" (e.g. `Disallow:` allows everything).
        if (current !== null && value !== "")
          current.rules.push({ type: key, pattern: value, line });
        return;
      }
      case "crawl-delay": {
        lastWasUserAgent = false;
        const seconds = parseCrawlDelay(value);
        if (current !== null && seconds !== null) current.crawlDelaySeconds = seconds;
        return;
      }
      case "sitemap": {
        if (value !== "") sitemaps.push({ url: value, line });
        return;
      }
      default:
        return; // unknown records are ignored and do not end a group
    }
  });

  return { groups, sitemaps, truncated };
}
