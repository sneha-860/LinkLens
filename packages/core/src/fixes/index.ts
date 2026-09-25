/**
 * Fixes. Candidate generation (targets, admissible donors with reasons, capped by REF). Still to
 * come: fix simulation (edge added to a graph copy, PageRank recomputed) and ranking by
 * S(u→v) = ΔPR_v × σ_hybrid(u,v) / κ(u), with rule-based explanations and orphan rescue donors.
 */
export * from "./candidates.js";
export * from "./counterfactual.js";
export * from "./counterfactual-inputs.js";
export * from "./effort.js";
export * from "./scoring.js";
