import { z } from "zod";
import { audit, diagnosis, SIGMA_VARIANTS } from "@linklens/core";

export const POLICY_IDS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export const PolicySchema = z
  .enum(POLICY_IDS)
  .describe("Canonicalisation policy (P0 finest … P5 coarsest)");
export const SigmaSchema = z.enum(SIGMA_VARIANTS).describe("σ variant used to score fixes");

export const CreateAuditSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }).describe("Site root to crawl (http or https)"),
    pageCap: z.int().min(1).max(500).optional().describe("Max URLs admitted to the crawl (≤ 500)"),
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
          .describe("Overrides of packages/core config.ts for this run (validated by makeConfig)"),
      })
      .strict()
      .default({}),
  })
  .strict();
export type CreateAuditBody = z.infer<typeof CreateAuditSchema>;

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

export const FixesQuerySchema = z
  .object({
    sigma: SigmaSchema.optional(),
    k: z.coerce
      .number()
      .pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
      .optional()
      .describe("Top k: 10, 25 or 50 (default config.fixTopK)"),
    scope: z.enum(["global", "target"]).default("global").describe("Top k overall, or per target"),
  })
  .strict();

export const AnalyticsQuerySchema = z
  .object({ name: z.string().min(1).max(200).optional().describe("Label for the uploaded file") })
  .strict();
