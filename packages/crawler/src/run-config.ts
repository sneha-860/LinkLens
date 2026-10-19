import { makeConfig, politenessProblems, type LinkLensConfig } from "@linklens/core";
import { checkUserAgent } from "./user-agent.js";

/**
 * The config a follow-up fetcher (discovery, orphan rescue) runs with: the run's stored config
 * with the caller's overrides, which may only make it more polite (a longer delay, a smaller
 * cap), never less. The User-Agent is checked again, since an override could replace the one
 * createRun accepted. Throws with every problem.
 */
export function followUpConfig(
  stored: Partial<LinkLensConfig>,
  overrides: Partial<LinkLensConfig> = {},
): Readonly<LinkLensConfig> {
  const base = makeConfig(stored);
  const problems = politenessProblems(overrides, base);
  const config = makeConfig({ ...stored, ...overrides });
  const ua = checkUserAgent(config.userAgent);
  if (ua.length > 0) problems.push(`config.userAgent is not identifying: ${ua.join("; ")}`);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return config;
}
