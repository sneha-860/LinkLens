/**
 * Semantic layer. REF(A,B): directional containment of the target's view S_B = Title ∪ Body in
 * the donor's view S_A = Links ∪ Body, over the site-specific TF-IDF token sets (see ../text),
 * with the ε cutoff and per-node normalisation ρ. The patent's session popularity is replaced by
 * structural link prominence (never "popularity").
 */
export * from "./ref.js";
