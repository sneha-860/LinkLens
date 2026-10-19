import { fixes } from "@linklens/core";

/**
 * L13 features of a candidate link u → v (the ML prioritiser's inputs). Every row is measured in
 * the world the ranking would see: for E6 labels the masked site (the hidden link removed, its
 * anchors stripped, text and embeddings rebuilt), so no feature carries the answer.
 *
 * The definitions live in core (`fixes/features.ts`), so the pipeline's learnedScore stage builds
 * the rows it serves with exactly the code that built the training rows.
 */
export const {
  NUMERIC_FEATURES,
  CATEGORICAL_FEATURES,
  FEATURES,
  nodeFacts,
  detachedFacts,
  jaccardOf,
  sScore,
  pairFeatures,
} = fixes;
export type Feature = fixes.Feature;
export type PairFeatures = fixes.PairFeatures;
export type NodeFacts = fixes.NodeFacts;
export type PairInput = fixes.PairInput;
