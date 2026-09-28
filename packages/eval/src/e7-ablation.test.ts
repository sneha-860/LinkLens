import { describe, expect, it } from "vitest";
import { SIGMA_VARIANTS, makeConfig } from "@linklens/core";
import { e7Settings } from "./e7-ablation.js";

describe("e7Settings", () => {
  const config = makeConfig();
  const settings = e7Settings(config);

  it("covers every σ along the ε sweep (default α) and the α sweep (default ε), once each", () => {
    // The default ε (0.2) and α (0.1) are in the sweeps: 8 ε + 6 α − 1 shared, per σ, under S;
    // plus each σ at the default ε and α under S_imp.
    expect(settings).toHaveLength(SIGMA_VARIANTS.length * (8 + 6 - 1 + 1));
    const keys = settings.map((s) => `${s.sigma}|${s.epsilon}|${s.alpha}|${s.scoring}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of settings) {
      expect(s.epsilon === config.epsilon || s.alpha === config.alpha).toBe(true);
    }
  });

  it("marks the sweeps each setting belongs to, and the one default", () => {
    const defaults = settings.filter((s) => s.isDefault);
    expect(defaults).toEqual([
      {
        sigma: "refGateCosine",
        epsilon: 0.2,
        alpha: 0.1,
        scoring: "S",
        isDefault: true,
        sweeps: ["sigma", "epsilon", "alpha", "scoring"],
      },
    ]);
    const sigmaSweep = settings.filter((s) => s.sweeps.includes("sigma"));
    expect(sigmaSweep.map((s) => s.sigma).sort()).toEqual([...SIGMA_VARIANTS].sort());
    expect(sigmaSweep.every((s) => s.scoring === "S")).toBe(true);
    // The scoring sweep: each σ at the default ε and α under S and under S_imp (L12).
    const scoringSweep = settings.filter((s) => s.sweeps.includes("scoring"));
    expect(scoringSweep).toHaveLength(SIGMA_VARIANTS.length * 2);
    for (const s of scoringSweep) expect([s.epsilon, s.alpha]).toEqual([0.2, 0.1]);
    const imp = settings.filter((s) => s.scoring === "S_imp");
    expect(imp.every((s) => s.sweeps.join() === "scoring" && !s.isDefault)).toBe(true);
    // With S_imp as the run's own scoring, the S_imp setting is the default.
    expect(
      e7Settings(makeConfig({ fixScoring: "S_imp" })).filter((s) => s.isDefault),
    ).toMatchObject([{ sigma: "refGateCosine", scoring: "S_imp" }]);
    const eps = settings.filter((s) => s.sweeps.includes("epsilon") && s.sigma === "cosineOnly");
    expect(eps.map((s) => s.epsilon)).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
    const alphas = settings.filter((s) => s.sweeps.includes("alpha") && s.sigma === "blended");
    expect(alphas.map((s) => s.alpha)).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);
  });

  it("adds the default ε and α when the sweeps leave them out", () => {
    const s = e7Settings(
      makeConfig({ epsilon: 0.22, alpha: 0.12, e7Epsilons: [0.1], e7Alphas: [0.3] }),
    );
    // (0.1, 0.22) × α0 and ε0 × (0.12, 0.3), minus the shared default; plus S_imp at the default.
    expect(s).toHaveLength(SIGMA_VARIANTS.length * 4);
    expect(s.filter((x) => x.isDefault)).toHaveLength(1);
  });
});
