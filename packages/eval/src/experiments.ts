export interface ExperimentInfo {
  readonly id: string;
  readonly title: string;
  readonly optional: boolean;
}

/** Registry of evaluation experiments. Each gets its own module under src/eN/ when implemented. */
export const experiments: readonly ExperimentInfo[] = [
  { id: "E1", title: "Canonicalisation sensitivity", optional: false },
  { id: "E2", title: "Channel ablation", optional: false },
  { id: "E3", title: "Fixes vs baselines", optional: false },
  { id: "E4", title: "14-day re-crawl stability", optional: false },
  { id: "E5", title: "Screaming Frog calibration", optional: false },
  { id: "E6", title: "Hide-and-recover", optional: false },
  { id: "E7", title: "σ ablation", optional: false },
  { id: "E8", title: "Human rating", optional: true },
];
