/**
 * The patent's text representation: per-page Title / Links / Body fields, tokenised (stop-words,
 * numbers, Porter stems, unigrams + bigrams), site-specific boilerplate removal, TF-IDF, and the
 * donor (S_A = Links ∪ Body) and target (S_B = Title ∪ Body) views.
 */
export * from "./tokenise.js";
export * from "./model.js";
export * from "./run.js";
