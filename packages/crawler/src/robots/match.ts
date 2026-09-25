import { matchTarget, normalisePattern } from "./normalise.js";
import type { ParsedRobots, RobotsGroup, RobotsRule } from "./parse.js";
import { productToken } from "../user-agent.js";

/**
 * Does `pattern` (normalised) match the start of `target` (normalised)?
 * `*` matches any run of octets; a trailing `$` anchors at the end; otherwise it is a prefix match.
 *
 * Runs in O(|pattern| × |target|) by tracking the set of reachable positions in `target`, so
 * hostile patterns such as `/*a*a*a*a*b` cannot cause exponential backtracking.
 */
export function patternMatches(pattern: string, target: string): boolean {
  let positions: number[] = [0];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "$" && i === pattern.length - 1) {
      return positions.includes(target.length);
    }
    if (ch === "*") {
      const from = positions[0] as number; // positions is sorted ascending
      positions = [];
      for (let p = from; p <= target.length; p++) positions.push(p);
      continue;
    }
    const next: number[] = [];
    for (const p of positions) if (p < target.length && target[p] === ch) next.push(p + 1);
    if (next.length === 0) return false;
    positions = next;
  }
  return true;
}

/** The product token of a `User-agent` value ("FooBot/1.2" → "foobot"), or "*" / null. */
function groupToken(value: string): string | null {
  const v = value.trim();
  if (v.startsWith("*")) return "*";
  return /^[A-Za-z_-]+/.exec(v)?.[0].toLowerCase() ?? null;
}

/**
 * Pick the rules that apply to `userAgent` (RFC 9309 §2.2.1):
 *  - every group naming our product token (case-insensitive) is merged: the most specific match;
 *  - only if there is none, every `*` group is merged;
 *  - if neither exists, no rules apply.
 * A matching group with no rules still wins over `*` (so the crawler is allowed everything).
 */
export function selectGroups(robots: ParsedRobots, userAgent: string): RobotsGroup[] {
  const ours = productToken(userAgent).toLowerCase();
  const specific = robots.groups.filter((g) => g.userAgents.some((ua) => groupToken(ua) === ours));
  if (specific.length > 0) return specific;
  return robots.groups.filter((g) => g.userAgents.some((ua) => groupToken(ua) === "*"));
}

export interface CompiledRule extends RobotsRule {
  /** Pattern after percent-encoding normalisation. */
  readonly normalised: string;
  /** Specificity: octet count of the normalised pattern (RFC 9309 §2.2.2 "most octets"). */
  readonly length: number;
}

export interface MatchDecision {
  readonly allowed: boolean;
  /** The winning rule, or null if no rule matched (or the decision is implicit). */
  readonly rule: CompiledRule | null;
  readonly reason: "rule" | "no-match" | "robots-txt-always-allowed" | "robots-unreachable";
}

export function compileRules(groups: readonly RobotsGroup[]): CompiledRule[] {
  return groups.flatMap((g) =>
    g.rules.map((r) => {
      const normalised = normalisePattern(r.pattern);
      return { ...r, normalised, length: normalised.length };
    }),
  );
}

/**
 * Longest-match decision (RFC 9309 §2.2.2): the matching rule with the most octets wins; on a tie
 * between allow and disallow, allow wins. No match means allowed. /robots.txt is always allowed.
 */
export function decide(rules: readonly CompiledRule[], url: URL): MatchDecision {
  if (url.pathname === "/robots.txt") {
    return { allowed: true, rule: null, reason: "robots-txt-always-allowed" };
  }
  const target = matchTarget(url);
  let best: CompiledRule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.normalised, target)) continue;
    if (
      best === null ||
      rule.length > best.length ||
      (rule.length === best.length && rule.type === "allow" && best.type === "disallow")
    ) {
      best = rule;
    }
  }
  if (best === null) return { allowed: true, rule: null, reason: "no-match" };
  return { allowed: best.type === "allow", rule: best, reason: "rule" };
}
