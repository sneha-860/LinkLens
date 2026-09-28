/**
 * Rule-based structural issues (orphans, deep pages, weak authority, SCC, dead ends,
 * noindex/nofollow conflicts) from a policy's graph metrics and reconciled inventory; and link
 * health (broken internal links, redirect chains) from the recorded fetches.
 */
export * from "./structural.js";
export * from "./link-health.js";
