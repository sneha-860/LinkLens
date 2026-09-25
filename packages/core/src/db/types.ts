import type { LinkLensConfig } from "../config.js";
import type { DiscoveryChannel } from "../discovery/channels.js";

/**
 * Anything that can run a parameterised SQL query. `packages/db` adapts a `pg` Pool/Client to
 * this, so core stays free of drivers and network I/O.
 */
export interface Queryable {
  query<R>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Database ids are Postgres bigint, parsed to number by `packages/db`. */
export type Id = number;

export const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Statuses that end a run; setting one stamps finished_at. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

// ---------- sites ----------
export interface SiteRow {
  id: Id;
  rootUrl: string;
  architectureClass: string | null;
  createdAt: Date;
}
export interface NewSite {
  rootUrl: string;
  architectureClass?: string | null;
}

// ---------- runs ----------
export interface RunRow {
  id: Id;
  siteId: Id;
  startedAt: Date;
  finishedAt: Date | null;
  config: LinkLensConfig;
  status: RunStatus;
  seed: number;
}
export interface NewRun {
  siteId: Id;
  config: Readonly<LinkLensConfig>;
  /** Defaults to `config.randomSeed`. */
  seed?: number;
  status?: RunStatus;
}

// ---------- fetches ----------
export const FETCH_PURPOSES = ["crawl", "robots", "discovery"] as const;
export type FetchPurpose = (typeof FETCH_PURPOSES)[number];

/** One 3xx response in a redirect chain. `location` is the raw Location header value. */
export interface RedirectHop {
  url: string;
  statusCode: number;
  location?: string | null;
}
export interface FetchRow {
  id: Id;
  runId: Id;
  requestedUrl: string;
  finalUrl: string | null;
  statusCode: number | null;
  redirectChain: RedirectHop[];
  headers: Record<string, string>;
  contentType: string | null;
  fetchedAt: Date;
  bytes: number | null;
  error: string | null;
  /** 1 for the first try at this URL, 2+ for retries. */
  attempt: number;
  /** Why the request was made; only "crawl" fetches count toward pageCap. */
  purpose: FetchPurpose;
}
export interface NewFetch {
  runId: Id;
  requestedUrl: string;
  finalUrl?: string | null;
  statusCode?: number | null;
  redirectChain?: RedirectHop[];
  headers?: Record<string, string>;
  contentType?: string | null;
  fetchedAt?: Date;
  bytes?: number | null;
  error?: string | null;
  attempt?: number;
  purpose?: FetchPurpose;
}

// ---------- fetch_bodies (append-only) ----------
export interface FetchBodyRow {
  fetchId: Id;
  runId: Id;
  /** Raw response bytes as received (up to maxBodyBytes). */
  body: Uint8Array;
  truncated: boolean;
  /** Lower-case hex SHA-256 of `body`. */
  sha256: string;
  createdAt: Date;
}
export interface NewFetchBody {
  fetchId: Id;
  runId: Id;
  body: Uint8Array;
  truncated: boolean;
  sha256: string;
}

// ---------- pages ----------
export interface Heading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}
export interface PageRow {
  id: Id;
  runId: Id;
  fetchId: Id;
  url: string;
  title: string | null;
  h1: string | null;
  headings: Heading[];
  metaCanonical: string | null;
  metaRobots: string | null;
  bodyText: string | null;
  paragraphs: string[];
  lang: string | null;
  /** meta robots nofollow/none on this page (recorded; links are still all observed). */
  nofollow: boolean;
}
export interface NewPage {
  runId: Id;
  fetchId: Id;
  url: string;
  title?: string | null;
  h1?: string | null;
  headings?: Heading[];
  metaCanonical?: string | null;
  metaRobots?: string | null;
  bodyText?: string | null;
  paragraphs?: string[];
  lang?: string | null;
  nofollow?: boolean;
}

// ---------- link_observations (append-only) ----------
export interface LinkObservationRow {
  id: Id;
  runId: Id;
  sourceFetchId: Id;
  rawHref: string;
  resolvedUrl: string | null;
  anchorText: string | null;
  rel: string | null;
  domRegion: string | null;
  domPath: string | null;
  templateSignature: string | null;
  positionIndex: number;
}
export interface NewLinkObservation {
  runId: Id;
  sourceFetchId: Id;
  rawHref: string;
  resolvedUrl?: string | null;
  anchorText?: string | null;
  rel?: string | null;
  domRegion?: string | null;
  domPath?: string | null;
  templateSignature?: string | null;
  positionIndex: number;
}

// ---------- discovery_observations (append-only) ----------
export interface DiscoveryObservationRow {
  id: Id;
  runId: Id;
  channel: DiscoveryChannel;
  url: string;
  sourceDocument: string | null;
  observedAt: Date;
  /** Raw provenance (sitemap chain, raw loc, feed format, anchor text…). kind "directive" = not a page. */
  detail: { [key: string]: Json };
}
export interface NewDiscoveryObservation {
  runId: Id;
  channel: DiscoveryChannel;
  url: string;
  sourceDocument?: string | null;
  observedAt?: Date;
  detail?: { [key: string]: Json };
}

// ---------- analytics_clicks (append-only) ----------
/** One line of an imported analytics CSV, as written (URLs are not normalised). */
export interface AnalyticsClickRow {
  id: Id;
  runId: Id;
  sourceUrl: string;
  targetUrl: string;
  clicks: number;
  sourceDocument: string | null;
  /** CSV line number (the header is line 1). */
  lineNumber: number;
  importedAt: Date;
}
export interface NewAnalyticsClick {
  runId: Id;
  sourceUrl: string;
  targetUrl: string;
  clicks: number;
  sourceDocument?: string | null;
  lineNumber: number;
}

// ---------- artefacts ----------
export interface ArtefactRow<P extends Json = Json> {
  id: Id;
  runId: Id;
  policyVersion: string;
  kind: string;
  payload: P;
  createdAt: Date;
}
export interface NewArtefact<P extends Json = Json> {
  runId: Id;
  policyVersion: string;
  kind: string;
  payload: P;
}
