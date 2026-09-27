import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import {
  SIGMA_VARIANTS,
  canonicalise,
  defaultConfig,
  makeConfig,
  semantic,
  type LinkLensConfig,
} from "@linklens/core";

/**
 * The evaluation corpus (corpus.yaml): sites grouped into architecture classes, audited with one
 * fixed config and seed.
 */
export interface CorpusSite {
  readonly id: string;
  readonly url: string;
  readonly architectureClass: string;
  readonly notes: string;
  /** E5: a site whose Screaming Frog exports are compared with LinkLens (10 of the corpus). */
  readonly screamingFrog: boolean;
}

export interface CorpusClass {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface Corpus {
  readonly version: 1;
  readonly seed: number;
  readonly policy: canonicalise.PolicyId;
  readonly sigma: (typeof SIGMA_VARIANTS)[number];
  readonly refVariant: semantic.RefVariant;
  /**
   * After each audit, also rank fixes under the other five policies (the per-policy ranking job),
   * so E1 can compare top-k fix lists between every pair of policies.
   */
  readonly rankAllPolicies: boolean;
  /** Overrides of the defaults in packages/core/src/config.ts, as written. */
  readonly config: Partial<LinkLensConfig>;
  readonly classes: readonly CorpusClass[];
  /** In file order: the order the batch audits them. */
  readonly sites: readonly CorpusSite[];
  /** SHA-256 of the file's bytes. */
  readonly sha256: string;
}

const SITE_ID = /^[a-z0-9][a-z0-9-]*$/;

const FileSchema = z
  .object({
    version: z.literal(1),
    seed: z.number().int().nonnegative(),
    policy: z.enum(canonicalise.POLICY_IDS),
    sigma: z.enum(SIGMA_VARIANTS),
    refVariant: z.enum(semantic.REF_VARIANTS),
    rankAllPolicies: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).default({}),
    classes: z.record(
      z.string().regex(SITE_ID),
      z.object({ label: z.string().min(1), description: z.string().default("") }).strict(),
    ),
    sites: z
      .array(
        z
          .object({
            id: z.string().regex(SITE_ID, "lower-case letters, digits and hyphens"),
            url: z.url({ protocol: /^https?$/ }),
            architecture_class: z.string(),
            notes: z.string().default(""),
            screaming_frog: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Parse and check corpus.yaml; every problem is reported at once. */
export function parseCorpus(text: string): Corpus {
  const parsed = FileSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new Error(`invalid corpus: ${z.prettifyError(parsed.error)}`);
  }
  const f = parsed.data;
  const problems: string[] = [];

  const known = new Set(Object.keys(defaultConfig));
  for (const key of Object.keys(f.config)) {
    if (!known.has(key)) problems.push(`config.${key} is not a LinkLens config key`);
  }
  if ("randomSeed" in f.config) problems.push("set the seed with `seed`, not config.randomSeed");

  const classIds = Object.keys(f.classes);
  const seen = new Map<string, string>();
  for (const s of f.sites) {
    if (seen.has(s.id)) problems.push(`site id ${s.id} is used twice`);
    seen.set(s.id, s.url);
    if (!classIds.includes(s.architecture_class)) {
      problems.push(`site ${s.id}: unknown architecture_class ${s.architecture_class}`);
    }
  }
  const urls = new Map<string, string>();
  for (const s of f.sites) {
    const key = new URL(s.url).toString();
    const other = urls.get(key);
    if (other !== undefined) problems.push(`sites ${other} and ${s.id} have the same URL`);
    urls.set(key, s.id);
  }
  for (const c of classIds) {
    if (!f.sites.some((s) => s.architecture_class === c)) problems.push(`class ${c} has no site`);
  }
  if (problems.length > 0) throw new Error(`invalid corpus:\n  ${problems.join("\n  ")}`);

  const corpus: Corpus = {
    version: 1,
    seed: f.seed,
    policy: f.policy,
    sigma: f.sigma,
    refVariant: f.refVariant,
    rankAllPolicies: f.rankAllPolicies,
    config: f.config as Partial<LinkLensConfig>,
    classes: classIds.map((id) => {
      const c = f.classes[id] as { label: string; description: string };
      return { id, label: c.label, description: c.description.trim() };
    }),
    sites: f.sites.map((s) => ({
      id: s.id,
      url: s.url,
      architectureClass: s.architecture_class,
      notes: s.notes.trim(),
      screamingFrog: s.screaming_frog,
    })),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  resolveConfig(corpus); // validates the values too
  return corpus;
}

/**
 * The config every site of the batch runs with: the defaults, the corpus overrides, the seed,
 * and the User-Agent override when there is one (LINKLENS_USER_AGENT).
 */
export function resolveConfig(
  corpus: Pick<Corpus, "config" | "seed">,
  userAgent?: string,
): Readonly<LinkLensConfig> {
  return makeConfig({
    ...corpus.config,
    randomSeed: corpus.seed,
    ...(userAgent === undefined || userAgent === "" ? {} : { userAgent }),
  });
}

/** Sites per class, in the corpus's class order. */
export function sitesByClass(corpus: Corpus): Map<string, CorpusSite[]> {
  const out = new Map<string, CorpusSite[]>(corpus.classes.map((c) => [c.id, []]));
  for (const s of corpus.sites) out.get(s.architectureClass)?.push(s);
  return out;
}
