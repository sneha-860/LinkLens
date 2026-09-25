import { describe, expect, it } from "vitest";
import { fixes, makeConfig } from "@linklens/core";
import { resolveWorkers, simulateInWorkers } from "./pool.js";

const config = makeConfig();
const params: fixes.PageRankParams = {
  pagerankDamping: config.pagerankDamping,
  pagerankTolerance: config.pagerankTolerance,
  pagerankMaxIterations: config.pagerankMaxIterations,
};

// A 60-page site: a hub, a chain of deep pages, and a few cross links.
const nodes = Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, "0")}`);
const links = [
  ...nodes.slice(1, 20).map((n) => ({ source: "p00", target: n, weight: 1 })),
  ...nodes.slice(20, 59).map((n, i) => ({ source: n, target: nodes[21 + i] as string, weight: 1 })),
  { source: "p01", target: "p20", weight: 0.1 },
  ...nodes.slice(1, 60).map((n) => ({ source: n, target: "p00", weight: 0.3 })),
];
const graph = fixes.weightedGraph(nodes, "p00", links);
const base = fixes.baseline(graph, params);
const scenarios: fixes.Scenario[] = nodes.slice(20).flatMap((t, i) => [
  { id: `add:${i}`, donor: 0, target: nodes.indexOf(t), action: "add-link" as const },
  { id: `vis:${i}`, donor: (i % 19) + 1, target: nodes.indexOf(t), action: "add-link" as const },
]);

describe("simulateInWorkers", () => {
  it("returns the same results as simulating in this thread, in scenario order", async () => {
    const run = await simulateInWorkers(
      { graph, baseline: base, bodyWeight: 1, params },
      scenarios,
      3,
    );
    expect(run.workers).toBe(3);
    expect(run.results.map((r) => r.candidateId)).toEqual(scenarios.map((s) => s.id));
    scenarios.forEach((s, i) => {
      const { runtimeMs, ...rest } = run.results[i] as (typeof run.results)[number];
      expect(runtimeMs).toBeGreaterThanOrEqual(0);
      expect(rest).toEqual(fixes.simulate(graph, base, s, 1, params));
    });
  });

  it("does not depend on the number of workers", async () => {
    const strip = (r: { runtimeMs: number }[]) => r.map(({ runtimeMs: _, ...x }) => x);
    const one = await simulateInWorkers(
      { graph, baseline: base, bodyWeight: 1, params },
      scenarios,
      1,
    );
    const four = await simulateInWorkers(
      { graph, baseline: base, bodyWeight: 1, params },
      scenarios,
      4,
    );
    expect(strip(four.results)).toEqual(strip(one.results));
    expect(one.workers).toBe(1);
  });

  it("finds that linking a deep page from the home page lifts it and cuts its depth", async () => {
    const run = await simulateInWorkers(
      { graph, baseline: base, bodyWeight: 1, params },
      scenarios.slice(-2, -1), // home → p59, the end of the chain (home → p01 → p20 → … → p59)
      2,
    );
    expect(run.workers).toBe(1); // never more workers than chunks
    expect(run.results[0]).toMatchObject({ depthBefore: 41, depthAfter: 1, deltaDepth: -40 });
    expect(run.results[0]?.deltaPrTarget).toBeGreaterThan(0);
  });

  it("handles no scenarios without starting workers", async () => {
    expect(
      await simulateInWorkers({ graph, baseline: base, bodyWeight: 1, params }, [], 4),
    ).toEqual({
      results: [],
      workers: 0,
      chunks: 0,
      wallMs: 0,
    });
  });

  it("resolves 0 workers to half the logical processors (at least 1)", () => {
    expect(resolveWorkers(0)).toBeGreaterThanOrEqual(1);
    expect(resolveWorkers(3)).toBe(3);
  });
});
