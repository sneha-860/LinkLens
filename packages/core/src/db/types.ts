import type { LinkLensConfig } from "../config.js";
import type { DiscoveryChannel } from "../discovery/index.js";

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
}
export interface NewDiscoveryObservation {
  runId: Id;
  channel: DiscoveryChannel;
  url: string;
  sourceDocument?: string | null;
  observedAt?: Date;
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
