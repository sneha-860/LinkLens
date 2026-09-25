import { RobotsPolicy } from "./policy.js";

export interface RobotsFetchFact {
  readonly fetchedAt: Date;
  /** null for network errors/timeouts. */
  readonly statusCode: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True if this robots.txt fetch counts as "unreachable": 5xx or no response at all
 * (and 429 when `treat429` mirrors config.robotsTreat429AsUnreachable).
 */
export function isUnreachable(f: RobotsFetchFact, treat429 = false): boolean {
  return f.statusCode === null || f.statusCode >= 500 || (treat429 && f.statusCode === 429);
}

/**
 * Start of the current unbroken run of unreachable robots.txt fetches, or null if the most recent
 * fetch was reachable. `history` must be newest first and include the current fetch.
 */
export function unreachableSince(
  history: readonly RobotsFetchFact[],
  treat429 = false,
): Date | null {
  let since: Date | null = null;
  for (const f of history) {
    if (!isUnreachable(f, treat429)) break;
    since = f.fetchedAt;
  }
  return since;
}

/**
 * RFC 9309 §2.3.1.4: if robots.txt has been unreachable for `graceDays` or more, the crawler MAY
 * treat it as unavailable (allow all) instead of disallow all. Any other policy is returned unchanged.
 */
export function applyUnreachableGrace(
  policy: RobotsPolicy,
  history: readonly RobotsFetchFact[],
  now: Date,
  graceDays: number,
  treat429 = false,
): RobotsPolicy {
  if (policy.source.kind !== "unreachable") return policy;
  const since = unreachableSince(history, treat429);
  if (since === null || now.getTime() - since.getTime() < graceDays * DAY_MS) return policy;
  return new RobotsPolicy(
    {
      kind: "unavailable",
      detail: `unreachable since ${since.toISOString()} (≥ ${graceDays} days): ${policy.source.detail}`,
    },
    policy.userAgent,
  );
}
