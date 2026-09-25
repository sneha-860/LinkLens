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

export interface Explanation {
  sentence: string;
  lines: string[];
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

export interface FixesResponse {
  sigma: SigmaVariant;
  k: number;
  scope: "global" | "target";
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
export interface GraphResponse {
  policy: Policy;
  policyVersion: string;
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
