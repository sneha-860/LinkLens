/** Response shapes of the LinkLens API (packages/api), as the UI uses them. */

export const POLICIES = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type Policy = (typeof POLICIES)[number];
export const SIGMA_VARIANTS = ["refGateCosine", "cosineOnly", "refOnly", "blended"] as const;
export type SigmaVariant = (typeof SIGMA_VARIANTS)[number];
export const CASES = ["v4", "v3", "v1", "v2"] as const;
export type DiagnosisCase = (typeof CASES)[number];
export const CHANNELS = [
  "link_graph",
  "xml_sitemap",
  "robots_sitemap",
  "html_sitemap",
  "feed",
  "llms_txt",
] as const;
export type Channel = (typeof CHANNELS)[number];

export type AuditStatus = "queued" | "running" | "completed" | "failed";
export type StageStatus = "pending" | "running" | "completed" | "failed";

export interface StageView {
  stage: string;
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  detail: Record<string, unknown>;
  error: string | null;
}

export interface AuditListItem {
  id: number;
  url: string;
  policy: Policy;
  status: AuditStatus;
  currentStage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Audit extends AuditListItem {
  options: Record<string, unknown>;
  active: boolean;
  error: string | null;
  crawl: { status: string | null; pageCap: number | null; urlsFetched: number };
  progress: { completedStages: number; totalStages: number; fraction: number };
  stages: StageView[];
}

export interface CreateAuditRequest {
  url: string;
  pageCap?: number;
  policy: Policy;
  options?: { sigma?: SigmaVariant; config?: Record<string, unknown> };
}
export interface CreateAuditResponse {
  id: number;
  status: AuditStatus;
  policy: Policy;
}

export interface ChannelStats {
  total: number;
  exclusive: number;
  orphans: number;
}

/**
 * Element-level REF: the donor paragraph that best covers the target's title, and the anchor
 * to use in it (core fixes/anchor.ts).
 */
export type AnchorSuggestion =
  | {
      status: "suggested";
      paragraphIndex: number;
      paragraphs: number;
      ref: number;
      term: string;
      weight: number;
      share: number;
      anchor: string;
      excerpt: { text: string; anchorStart: number; anchorEnd: number };
      matched: { term: string; contribution: number; words: string }[];
    }
  | {
      status: "none";
      reason: "no-paragraphs" | "no-title-terms" | "not-above-epsilon";
      paragraphs: number;
      bestRef: number | null;
      bestParagraphIndex: number | null;
    };

// ---------- link health (broken links, redirect chains) ----------
export interface RedirectHop {
  url: string;
  statusCode: number;
  location?: string | null;
}

export interface LinkSource {
  page: string;
  node: string;
  links: number;
  anchors: string[];
  regions: string[];
}

interface LinkTarget {
  url: string;
  node: string;
  finalUrl: string | null;
  finalStatus: number | null;
  chain: RedirectHop[];
  error: string | null;
  links: number;
  sources: LinkSource[];
  hops: number;
}

export interface BrokenTarget extends LinkTarget {
  class: "4xx" | "5xx";
}

export interface RedirectChain extends LinkTarget {
  endsBroken: boolean;
}

export interface LinkHealthResponse {
  version: string;
  runId: number;
  policyVersion: string;
  summary: {
    internalLinks: number;
    checkedLinks: number;
    uncheckedLinks: number;
    failedLinks: number;
    brokenTargets: number;
    brokenLinks: number;
    brokenSourcePages: number;
    statuses: Record<string, number>;
    redirectTargets: number;
    chainTargets: number;
    chainLinks: number;
    maxHops: number;
    minChainHops: number;
  };
  broken: BrokenTarget[];
  redirectChains: RedirectChain[];
}

// ---------- E8 rating page ----------
export type Rater = "A" | "B";
export type Placement = "good" | "acceptable" | "poor" | "na";

/** A sampled fix as raters see it: no rank or score. */
export interface BlindItem {
  itemId: string;
  position: number;
  donor: string;
  target: string;
  donorTitle: string | null;
  targetTitle: string | null;
  action: "add-link" | "make-visible";
  placement: AnchorSuggestion | null;
}

export interface RatingAnswer {
  relevant: boolean;
  placement: Placement;
}

export interface RatingResponse {
  sample: {
    id: number;
    version: string;
    size: number;
    pool: number;
    sigmaVariant: SigmaVariant;
    items: BlindItem[];
  } | null;
  canCreate: boolean;
  rater?: Rater | null;
  name?: string | null;
  answers?: Record<string, RatingAnswer>;
}

export interface PrecisionAtK {
  k: number;
  rated: number;
  relevant: number;
  precision: number | null;
}

export interface RatingSummary {
  version: string;
  items: number;
  ks: number[];
  raters: {
    rater: Rater;
    name: string | null;
    rated: number;
    relevant: number;
    precisionAtK: PrecisionAtK[];
    placement: Record<Placement, number>;
  }[];
  consensus: { strict: PrecisionAtK[]; mean: { k: number; precision: number | null }[] };
  agreement: {
    items: number;
    relevance: { observed: number | null; kappa: number | null };
    placement: {
      items: number;
      observed: number | null;
      kappa: number | null;
      weightedKappa: number | null;
    };
  };
}

export interface Explanation {
  sentence: string;
  lines: string[];
  /** Fixes and rescue donors only; absent or null when not computed. */
  anchor?: AnchorSuggestion | null;
}

/** One feature's TreeSHAP contribution to the L13 model's raw score for a fix. */
export interface LearnedContribution {
  feature: string;
  value: number | string | null;
  contribution: number;
}

/** The L13 learned prioritiser's view of a fix (present once a model has been imported). */
export interface LearnedFix {
  /** In [0, 1]: the raw score's percentile among the site's fixes. */
  priority: number;
  raw: number;
  /** The largest |SHAP| contributions, largest first. */
  shap: LearnedContribution[];
}

export interface Fix {
  id: string;
  donor: string;
  target: string;
  type: "add-link" | "make-visible";
  prBefore: number;
  prAfter: number;
  deltaPr: number;
  deltaDepth: number | null;
  depthBefore: number | null;
  depthAfter: number | null;
  sigmaVariant: SigmaVariant;
  sigma: number;
  sigmas: Record<SigmaVariant, number>;
  ref: number;
  cosine: number | null;
  kappa: number;
  templateReach: number;
  score: number;
  /** S = ΔPR × σ / κ; `score` is S × importance when `scoring` is "S_imp" (L12). */
  scoreS?: number;
  scoring?: "S" | "S_imp" | "learned";
  importance?: number | null;
  /** L13: the model's priority and top SHAP contributions (null without an imported model). */
  learned?: LearnedFix | null;
  rank: number;
  targetRank: number;
  diagnosis: "v4" | "v3" | null;
  policyVersion: string;
  explanation?: Explanation | null;
}

export interface IssueSummary {
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<"high" | "medium" | "low", number>;
  nodesWithIssues: number;
  pagesAudited: number;
}

export interface Summary {
  id: number;
  url: string;
  policy: Policy;
  status: AuditStatus;
  progress: Audit["progress"];
  durationMs: number;
  pages: number;
  graph: { nodes: number; edges: number; reachable: number; sccCount: number } | null;
  discovery: {
    inventory: number;
    orphans: number;
    channels: Record<Channel, ChannelStats>;
  } | null;
  issues: IssueSummary | null;
  diagnosis: (Record<DiagnosisCase, number> & { pairs: number; unclassified: number }) | null;
  fixes: { total: number; sigma: SigmaVariant; top: Fix[] } | null;
  orphans: { orphans: number; scored: number; withDonors: number } | null;
}

export type FixScoringMode = "formula" | "learned";

export interface FixesResponse {
  sigma: SigmaVariant;
  k: number;
  scope: "global" | "target";
  scoring?: FixScoringMode;
  /** The imported L13 model: the site it scores and the sites it was trained on. */
  learnedModel?: { site: string; trainedOn: string[]; labels: string; createdAt: string } | null;
  total: number;
  fixes?: Fix[];
  targets?: { target: string; fixes: Fix[] }[];
}

export interface DiagnosisItem {
  id: string;
  case: DiagnosisCase;
  label: string;
  source: string;
  target: string;
  ref: number;
  rho: number;
  omega: number;
  severity: number;
  recommendation: string | null;
  explanation: string | null;
}
export interface DiagnosisResponse {
  alpha: number;
  epsilon: number;
  counts: Record<DiagnosisCase, number> & { pairs: number; unclassified: number };
  diagnoses: DiagnosisItem[];
}

export interface RescueDonor {
  rank: number;
  donor: string;
  ref: number;
  deltaPr: number;
  depthAfter: number | null;
  explanation: Explanation | null;
}
export interface Orphan {
  node: string;
  channels: Channel[];
  revealedBy: Channel[];
  status: "scored" | "no-page" | "no-text";
  shortlisted: number;
  donors: RescueDonor[];
}
export interface OrphansResponse {
  counts: { orphans: number; scored: number; withDonors: number };
  orphans: Orphan[];
}

export interface GraphNodeAttributes {
  pagerank?: number;
  depth?: number | null;
  reachable?: boolean;
  crawled?: boolean;
  inDegree?: number;
  outDegree?: number;
  betweennessNormalized?: number;
}
export type PageType = "homepage" | "hub" | "product" | "article" | "utility" | "other";

/** A node's page type and importance in [0, 1] (L12; heuristic weights). */
export interface NodeImportance {
  type: PageType;
  /** "seed", "url:<type>", "schema:<Type>", "structure:hub|article" or "default". */
  rule: string;
  evidence: string;
  importance: number;
  components: { typePrior: number; pagerank: number; depth: number; inboundBodyLinks: number };
  raw: { pagerank: number; depth: number | null; inboundBodyLinks: number };
  schemaTypes: string[];
}

export interface GraphResponse {
  policy: Policy;
  policyVersion: string;
  /** Page type and importance per node (null until the crawl has completed). */
  importance?: Record<string, NodeImportance> | null;
  graph: {
    attributes: { nodes?: number; edges?: number; seedNode?: string };
    nodes: { key: string; attributes: GraphNodeAttributes }[];
    edges: {
      key?: string;
      source: string;
      target: string;
      attributes?: { domRegion?: string | null; anchorText?: string | null };
    }[];
  };
}

export type IssueType =
  | "orphan"
  | "deep-page"
  | "weak-authority"
  | "outside-largest-scc"
  | "dead-end"
  | "noindex-nofollow-conflict";

export interface Issue {
  id: string;
  type: IssueType;
  rule?: string;
  node: string;
  severity: "high" | "medium" | "low";
  evidence: Record<string, unknown>;
}
export interface IssuesResponse {
  policy: Policy;
  policyVersion: string;
  issues: Issue[];
}

export interface SensitivityRow {
  policy: Policy;
  policyVersion: string;
  nodes: number;
  edges: number;
  reachable: number;
  largestScc: number;
  orphans: number;
  issues: number;
  meanDepth: number | null;
  /** Against the audit's policy, in P3 form. */
  pagerankSpearman: number | null;
  meanDepthShift: number | null;
  meanAbsDepthShift: number | null;
  /** null until fixes are ranked under this policy. */
  fixesRanked: number | null;
  topFixesJaccard: number | null;
}
export interface PolicyJob {
  status: "running" | "completed" | "failed";
  done: string[];
  current: string | null;
  error: string | null;
}
export interface SensitivityResponse {
  baselinePolicy: Policy;
  sigma: SigmaVariant;
  k: number;
  fixesJob: PolicyJob | null;
  policies: SensitivityRow[];
}

export interface InventoryEntry {
  node: string;
  channels: Channel[];
  urls: string[];
  reachable: boolean;
  depth: number | null;
  orphan: boolean;
}
export interface ReconciliationResponse {
  policy: Policy;
  orphans: number;
  channels: Record<Channel, ChannelStats>;
  inventory: InventoryEntry[];
}

/** Server-sent events of /audits/:id/events (besides the "snapshot", which is an Audit). */
export type AuditEvent =
  | { type: "stage"; stage: string; status: "running" }
  | { type: "stage"; stage: string; status: "completed"; durationMs: number }
  | { type: "stage"; stage: string; status: "failed"; durationMs: number; error: string }
  | { type: "progress"; pagesFetched: number; admitted: number; queueSize: number; url: string }
  | { type: "done"; status: "completed" | "failed"; error?: string }
  | { type: "idle"; status: AuditStatus };
