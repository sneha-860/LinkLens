import { z } from "zod";
import { audit, db, defaultConfig, diagnosis, SIGMA_VARIANTS } from "@linklens/core";

export const POLICY_IDS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export const PolicySchema = z
  .enum(POLICY_IDS)
  .describe("Canonicalisation policy (P0 finest … P5 coarsest)");
export const SigmaSchema = z.enum(SIGMA_VARIANTS).describe("σ variant used to score fixes");

export const CreateAuditSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }).describe("Site root to crawl (http or https)"),
    pageCap: z
      .int()
      .min(1)
      .max(defaultConfig.maxPageCap)
      .optional()
      .describe(
        `Max URLs admitted to the crawl (≤ config.maxPageCap, ${defaultConfig.maxPageCap})`,
      ),
    policy: PolicySchema.default("P3"),
    options: z
      .object({
        sigma: SigmaSchema.optional(),
        refVariant: z.enum(["weighted", "unweighted"]).optional(),
        workers: z
          .int()
          .min(0)
          .max(64)
          .optional()
          .describe("Counterfactual worker threads (0 = automatic)"),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Overrides of packages/core config.ts for this run (validated by makeConfig). Politeness settings may only be tightened: a lower crawl delay, a larger cap or pageCap above maxPageCap is refused (400)",
          ),
        models: z
          .object({
            importance: z
              .boolean()
              .optional()
              .describe("Run the importance stage: page types and importance (default true)"),
            learned: z
              .boolean()
              .optional()
              .describe(
                "Run the learnedScore stage: the L13 ranker's priority and SHAP (default true; skipped without a model)",
              ),
            graphsage: z
              .boolean()
              .optional()
              .describe(
                "Run the graphsageScore stage: GraphSAGE link scores (default config.graphsageEnabled; skipped without a model)",
              ),
          })
          .strict()
          .optional()
          .describe("Optional model stages, toggled per audit"),
      })
      .strict()
      .default({}),
  })
  .strict();
export type CreateAuditBody = z.infer<typeof CreateAuditSchema>;

export const SessionSchema = z.object({ key: z.string().min(1).max(1000) }).strict();

export const IdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export const PolicyQuerySchema = z.object({ policy: PolicySchema.optional() }).strict();

export const IssuesQuerySchema = z
  .object({
    policy: PolicySchema.optional(),
    type: z.enum(audit.ISSUE_TYPES).optional(),
    severity: z.enum(audit.SEVERITIES).optional(),
  })
  .strict();

export const DiagnosisQuerySchema = z.object({ case: z.enum(diagnosis.CASES).optional() }).strict();

/** How /fixes orders the fixes. */
export const FIX_MODES = ["formula", "importance", "learned"] as const;
export type FixMode = (typeof FIX_MODES)[number];

export const FixesQuerySchema = z
  .object({
    sigma: SigmaSchema.optional(),
    k: z.coerce
      .number()
      .pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
      .optional()
      .describe("Top k: 10, 25 or 50 (default config.fixTopK)"),
    scope: z.enum(["global", "target"]).default("global").describe("Top k overall, or per target"),
    mode: z
      .enum(FIX_MODES)
      .optional()
      .describe(
        "formula: S = ΔPR × σ / κ; importance: S_imp = S × importance(target) (L12); learned: the L13 ranker's priority (needs a learned-priority artefact). Default: the run's config.fixScoring (S → formula, S_imp → importance)",
      ),
    scoring: z
      .enum(["formula", "learned"])
      .optional()
      .describe("Deprecated alias of mode (formula: the run's default rule)"),
  })
  .strict();

export const AnalyticsQuerySchema = z
  .object({ name: z.string().min(1).max(200).optional().describe("Label for the uploaded file") })
  .strict();

export const SensitivityQuerySchema = z
  .object({
    k: z.coerce
      .number()
      .pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
      .default(10)
      .describe("Top k fixes compared between policies (Jaccard)"),
  })
  .strict();

export const RaterSchema = z.enum(db.RATERS).describe("Rater slot (two raters per sample)");

export const RatingQuerySchema = z
  .object({ rater: RaterSchema.optional().describe("Include this rater's own answers") })
  .strict();

export const RatingSchema = z
  .object({
    itemId: z.string().min(1).max(4000).describe("The item (fix id) as listed in the sample"),
    rater: RaterSchema,
    name: z.string().trim().min(1).max(100).describe("The rater's name"),
    relevant: z.boolean(),
    placement: z
      .enum(db.PLACEMENTS)
      .describe("Placement quality of the suggested paragraph and anchor; na when not relevant"),
  })
  .strict()
  .refine((r) => r.relevant || r.placement === "na", {
    message: "an item marked not relevant has placement na",
    path: ["placement"],
  });

export const EXPORT_FILES = [
  "audit.json",
  "summary.json",
  "issues.json",
  "issues.csv",
  "diagnosis.json",
  "diagnosis.csv",
  "fixes.json",
  "fixes.csv",
  "orphans.json",
  "orphans.csv",
  "explanations.json",
  "ratings.csv",
  "broken-links.csv",
  "redirect-chains.csv",
] as const;
export const ExportFileParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  file: z.enum(EXPORT_FILES),
});
