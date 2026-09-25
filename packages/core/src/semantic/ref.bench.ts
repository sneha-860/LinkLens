import { bench, describe } from "vitest";
import { makeConfig } from "../config.js";
import { buildTextModel } from "../text/model.js";
import { refMatrix } from "./ref.js";
import { syntheticSite } from "./synthetic.js";

// pnpm --filter @linklens/core exec vitest bench --run src/semantic
// 500 pages (the page cap) = 249,500 ordered pairs.
const scenarios = [
  {
    name: "500 pages, sparse overlap (default boilerplate drop)",
    config: makeConfig(),
    vocabulary: 8_000,
  },
  {
    name: "500 pages, dense overlap (no drop: every pair shares terms)",
    config: makeConfig({ frequentNgramDropPct: 0 }),
    vocabulary: 1_500,
  },
];

for (const { name, config, vocabulary } of scenarios) {
  const documents = syntheticSite({
    pages: 500,
    vocabulary,
    bodyWords: 600,
    anchors: 40,
    seed: 42,
  });
  const model = buildTextModel({ runId: 1, policyVersion: "P0@1.0.0", documents }, config);
  describe(name, () => {
    bench("refMatrix weighted", () => void refMatrix(model, "weighted", config), { iterations: 5 });
    bench("refMatrix unweighted", () => void refMatrix(model, "unweighted", config), {
      iterations: 5,
    });
  });
}
