import { buildInsert, type ColumnSpec } from "./sql.js";
import { TERMINAL_RUN_STATUSES } from "./types.js";
import type {
  AnalyticsClickRow,
  ArtefactRow,
  AuditRow,
  AuditStageRow,
  AuditStatus,
  DiscoveryObservationRow,
  FetchBodyRow,
  FetchPurpose,
  FetchRow,
  FixRatingRow,
  NewFixRating,
  Id,
  NewFetchBody,
  Json,
  LinkObservationRow,
  NewAnalyticsClick,
  NewArtefact,
  NewAudit,
  PolicyJobRow,
  PolicyJobStatus,
  NewDiscoveryObservation,
  NewFetch,
  NewLinkObservation,
  NewPage,
  NewRun,
  NewSite,
  PageRow,
  Queryable,
  RunRow,
  RunStatus,
  SiteRow,
} from "./types.js";
import type { DiscoveryChannel } from "../discovery/channels.js";

// SELECT lists that map snake_case columns to the camelCase row types.
const SITE_COLS = `id, root_url AS "rootUrl", architecture_class AS "architectureClass",
  created_at AS "createdAt"`;
const RUN_COLS = `id, site_id AS "siteId", started_at AS "startedAt", finished_at AS "finishedAt",
  config_json AS "config", status, seed`;
const FETCH_COLS = `id, run_id AS "runId", requested_url AS "requestedUrl", final_url AS "finalUrl",
  status_code AS "statusCode", redirect_chain AS "redirectChain", headers,
  content_type AS "contentType", fetched_at AS "fetchedAt", bytes, error, attempt, purpose`;
const FETCH_BODY_COLS = `fetch_id AS "fetchId", run_id AS "runId", body, truncated, sha256,
  created_at AS "createdAt"`;
const PAGE_COLS = `id, run_id AS "runId", fetch_id AS "fetchId", url, title, h1, headings,
  meta_canonical AS "metaCanonical", meta_robots AS "metaRobots", body_text AS "bodyText",
  paragraphs, lang, nofollow, base_href AS "baseHref"`;
const LINK_COLS = `id, run_id AS "runId", source_fetch_id AS "sourceFetchId", raw_href AS "rawHref",
  resolved_url AS "resolvedUrl", anchor_text AS "anchorText", rel, dom_region AS "domRegion",
  dom_path AS "domPath", template_signature AS "templateSignature",
  position_index AS "positionIndex"`;
const DISCOVERY_COLS = `id, run_id AS "runId", channel, url, source_document AS "sourceDocument",
  observed_at AS "observedAt", detail`;
const ANALYTICS_COLS = `id, run_id AS "runId", source_url AS "sourceUrl",
  target_url AS "targetUrl", clicks, source_document AS "sourceDocument",
  line_number AS "lineNumber", imported_at AS "importedAt"`;
const ARTEFACT_COLS = `id, run_id AS "runId", policy_version AS "policyVersion", kind, payload,
  created_at AS "createdAt"`;

async function one<R>(db: Queryable, text: string, values: readonly unknown[]): Promise<R> {
  const { rows } = await db.query<R>(text, values);
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function maybeOne<R>(
  db: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<R | null> {
  const { rows } = await db.query<R>(text, values);
  return rows[0] ?? null;
}

async function insertMany<T, R>(
  db: Queryable,
  table: string,
  columns: readonly ColumnSpec<T>[],
  rows: readonly T[],
  returning: string,
): Promise<R[]> {
  const out: R[] = [];
  for (const stmt of buildInsert(table, columns, rows, returning)) {
    const { rows: inserted } = await db.query<R>(stmt.text, stmt.values);
    out.push(...inserted);
  }
  return out;
}

// ---------- sites ----------
export function insertSite(db: Queryable, site: NewSite): Promise<SiteRow> {
  return one(
    db,
    `INSERT INTO sites (root_url, architecture_class) VALUES ($1, $2) RETURNING ${SITE_COLS}`,
    [site.rootUrl, site.architectureClass ?? null],
  );
}

export function getSite(db: Queryable, id: Id): Promise<SiteRow | null> {
  return maybeOne(db, `SELECT ${SITE_COLS} FROM sites WHERE id = $1`, [id]);
}

/** Oldest site whose root_url equals `rootUrl` exactly (no normalisation). */
export function getSiteByRootUrl(db: Queryable, rootUrl: string): Promise<SiteRow | null> {
  return maybeOne(db, `SELECT ${SITE_COLS} FROM sites WHERE root_url = $1 ORDER BY id LIMIT 1`, [
    rootUrl,
  ]);
}

// ---------- runs ----------
export function createRun(db: Queryable, run: NewRun): Promise<RunRow> {
  return one(
    db,
    `INSERT INTO runs (site_id, config_json, seed, status) VALUES ($1, $2::jsonb, $3, $4)
     RETURNING ${RUN_COLS}`,
    [
      run.siteId,
      JSON.stringify(run.config),
      run.seed ?? run.config.randomSeed,
      run.status ?? "pending",
    ],
  );
}

export function getRun(db: Queryable, id: Id): Promise<RunRow | null> {
  return maybeOne(db, `SELECT ${RUN_COLS} FROM runs WHERE id = $1`, [id]);
}

/** Sets the status; terminal statuses ("completed", "failed") also stamp finished_at. */
export function setRunStatus(db: Queryable, id: Id, status: RunStatus): Promise<RunRow> {
  return one(
    db,
    `UPDATE runs SET status = $2,
       finished_at = CASE WHEN $2 = ANY($3::text[]) THEN now() ELSE finished_at END
     WHERE id = $1 RETURNING ${RUN_COLS}`,
    [id, status, TERMINAL_RUN_STATUSES],
  );
}

// ---------- fetches ----------
const FETCH_SPEC: readonly ColumnSpec<NewFetch>[] = [
  { column: "run_id", get: (f) => f.runId },
  { column: "requested_url", get: (f) => f.requestedUrl },
  { column: "final_url", get: (f) => f.finalUrl ?? null },
  { column: "status_code", get: (f) => f.statusCode ?? null },
  { column: "redirect_chain", get: (f) => f.redirectChain ?? [], json: true },
  { column: "headers", get: (f) => f.headers ?? {}, json: true },
  { column: "content_type", get: (f) => f.contentType ?? null },
  { column: "fetched_at", get: (f) => f.fetchedAt ?? new Date() },
  { column: "bytes", get: (f) => f.bytes ?? null },
  { column: "error", get: (f) => f.error ?? null },
  { column: "attempt", get: (f) => f.attempt ?? 1 },
  { column: "purpose", get: (f) => f.purpose ?? "crawl" },
];

export async function insertFetch(db: Queryable, fetch: NewFetch): Promise<FetchRow> {
  const [row] = await insertMany<NewFetch, FetchRow>(
    db,
    "fetches",
    FETCH_SPEC,
    [fetch],
    FETCH_COLS,
  );
  if (row === undefined) throw new Error("insertFetch: no row returned");
  return row;
}

export async function listFetches(db: Queryable, runId: Id): Promise<FetchRow[]> {
  const { rows } = await db.query<FetchRow>(
    `SELECT ${FETCH_COLS} FROM fetches WHERE run_id = $1 ORDER BY id`,
    [runId],
  );
  return rows;
}

/** One row per requested URL: its last attempt (the `final_fetches` view). */
export async function listFinalFetches(db: Queryable, runId: Id): Promise<FetchRow[]> {
  const { rows } = await db.query<FetchRow>(
    `SELECT ${FETCH_COLS} FROM final_fetches WHERE run_id = $1 ORDER BY id`,
    [runId],
  );
  return rows;
}

/** Every fetch of exactly this URL across all runs, newest first (e.g. robots.txt history). */
export async function listFetchHistory(
  db: Queryable,
  requestedUrl: string,
  limit: number,
): Promise<FetchRow[]> {
  const { rows } = await db.query<FetchRow>(
    `SELECT ${FETCH_COLS} FROM fetches WHERE requested_url = $1
     ORDER BY fetched_at DESC, id DESC LIMIT $2`,
    [requestedUrl, limit],
  );
  return rows;
}

// ---------- fetch_bodies (append-only: insert + read only) ----------
export function insertFetchBody(db: Queryable, body: NewFetchBody): Promise<FetchBodyRow> {
  return one(
    db,
    `INSERT INTO fetch_bodies (fetch_id, run_id, body, truncated, sha256)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${FETCH_BODY_COLS}`,
    [body.fetchId, body.runId, body.body, body.truncated, body.sha256],
  );
}

export function getFetchBody(db: Queryable, fetchId: Id): Promise<FetchBodyRow | null> {
  return maybeOne(db, `SELECT ${FETCH_BODY_COLS} FROM fetch_bodies WHERE fetch_id = $1`, [fetchId]);
}

/** The stored bodies of these fetches of a run (those without one are absent), in fetch order. */
export async function listFetchBodies(
  db: Queryable,
  runId: Id,
  fetchIds: readonly Id[],
): Promise<FetchBodyRow[]> {
  if (fetchIds.length === 0) return [];
  const { rows } = await db.query<FetchBodyRow>(
    `SELECT ${FETCH_BODY_COLS} FROM fetch_bodies
     WHERE run_id = $1 AND fetch_id = ANY($2::bigint[]) ORDER BY fetch_id`,
    [runId, [...fetchIds]],
  );
  return rows;
}

// ---------- pages ----------
const PAGE_SPEC: readonly ColumnSpec<NewPage>[] = [
  { column: "run_id", get: (p) => p.runId },
  { column: "fetch_id", get: (p) => p.fetchId },
  { column: "url", get: (p) => p.url },
  { column: "title", get: (p) => p.title ?? null },
  { column: "h1", get: (p) => p.h1 ?? null },
  { column: "headings", get: (p) => p.headings ?? [], json: true },
  { column: "meta_canonical", get: (p) => p.metaCanonical ?? null },
  { column: "meta_robots", get: (p) => p.metaRobots ?? null },
  { column: "body_text", get: (p) => p.bodyText ?? null },
  { column: "paragraphs", get: (p) => p.paragraphs ?? [], json: true },
  { column: "lang", get: (p) => p.lang ?? null },
  { column: "nofollow", get: (p) => p.nofollow ?? false },
  { column: "base_href", get: (p) => p.baseHref ?? null },
];

export async function insertPage(db: Queryable, page: NewPage): Promise<PageRow> {
  const [row] = await insertMany<NewPage, PageRow>(db, "pages", PAGE_SPEC, [page], PAGE_COLS);
  if (row === undefined) throw new Error("insertPage: no row returned");
  return row;
}

/**
 * A run's pages, optionally only those whose fetch had `purpose` (e.g. "crawl": the link graph
 * is built from crawl pages only, never from rescued orphan pages).
 */
export async function listPages(
  db: Queryable,
  runId: Id,
  purpose?: FetchPurpose,
): Promise<PageRow[]> {
  const { rows } = await db.query<PageRow>(
    `SELECT ${PAGE_COLS} FROM pages
     WHERE run_id = $1
       AND ($2::text IS NULL OR fetch_id IN (SELECT id FROM fetches WHERE purpose = $2))
     ORDER BY id`,
    [runId, purpose ?? null],
  );
  return rows;
}

// ---------- link_observations (append-only: insert + read only) ----------
const LINK_SPEC: readonly ColumnSpec<NewLinkObservation>[] = [
  { column: "run_id", get: (l) => l.runId },
  { column: "source_fetch_id", get: (l) => l.sourceFetchId },
  { column: "raw_href", get: (l) => l.rawHref },
  { column: "resolved_url", get: (l) => l.resolvedUrl ?? null },
  { column: "anchor_text", get: (l) => l.anchorText ?? null },
  { column: "rel", get: (l) => l.rel ?? null },
  { column: "dom_region", get: (l) => l.domRegion ?? null },
  { column: "dom_path", get: (l) => l.domPath ?? null },
  { column: "template_signature", get: (l) => l.templateSignature ?? null },
  { column: "position_index", get: (l) => l.positionIndex },
];

export function insertLinkObservations(
  db: Queryable,
  links: readonly NewLinkObservation[],
): Promise<LinkObservationRow[]> {
  return insertMany(db, "link_observations", LINK_SPEC, links, LINK_COLS);
}

export async function listLinkObservations(
  db: Queryable,
  runId: Id,
): Promise<LinkObservationRow[]> {
  const { rows } = await db.query<LinkObservationRow>(
    `SELECT ${LINK_COLS} FROM link_observations WHERE run_id = $1 ORDER BY id`,
    [runId],
  );
  return rows;
}

// ---------- discovery_observations (append-only: insert + read only) ----------
const DISCOVERY_SPEC: readonly ColumnSpec<NewDiscoveryObservation>[] = [
  { column: "run_id", get: (d) => d.runId },
  { column: "channel", get: (d) => d.channel },
  { column: "url", get: (d) => d.url },
  { column: "source_document", get: (d) => d.sourceDocument ?? null },
  { column: "observed_at", get: (d) => d.observedAt ?? new Date() },
  { column: "detail", get: (d) => d.detail ?? {}, json: true },
];

export function insertDiscoveryObservations(
  db: Queryable,
  observations: readonly NewDiscoveryObservation[],
): Promise<DiscoveryObservationRow[]> {
  return insertMany(db, "discovery_observations", DISCOVERY_SPEC, observations, DISCOVERY_COLS);
}

export async function listDiscoveryObservations(
  db: Queryable,
  runId: Id,
  channel?: DiscoveryChannel,
): Promise<DiscoveryObservationRow[]> {
  const { rows } = await db.query<DiscoveryObservationRow>(
    `SELECT ${DISCOVERY_COLS} FROM discovery_observations
     WHERE run_id = $1 AND ($2::text IS NULL OR channel = $2) ORDER BY id`,
    [runId, channel ?? null],
  );
  return rows;
}

// ---------- analytics_clicks (append-only: insert + read only) ----------
const ANALYTICS_SPEC: readonly ColumnSpec<NewAnalyticsClick>[] = [
  { column: "run_id", get: (a) => a.runId },
  { column: "source_url", get: (a) => a.sourceUrl },
  { column: "target_url", get: (a) => a.targetUrl },
  { column: "clicks", get: (a) => a.clicks },
  { column: "source_document", get: (a) => a.sourceDocument ?? null },
  { column: "line_number", get: (a) => a.lineNumber },
];

export function insertAnalyticsClicks(
  db: Queryable,
  clicks: readonly NewAnalyticsClick[],
): Promise<AnalyticsClickRow[]> {
  return insertMany(db, "analytics_clicks", ANALYTICS_SPEC, clicks, ANALYTICS_COLS);
}

export async function listAnalyticsClicks(db: Queryable, runId: Id): Promise<AnalyticsClickRow[]> {
  const { rows } = await db.query<AnalyticsClickRow>(
    `SELECT ${ANALYTICS_COLS} FROM analytics_clicks WHERE run_id = $1 ORDER BY id`,
    [runId],
  );
  return rows;
}

// ---------- fix_ratings (append-only: insert + read only) ----------
const RATING_COLS = `id, run_id AS "runId", sample_artefact_id AS "sampleArtefactId",
  item_id AS "itemId", rater, rater_name AS "raterName", relevant, placement,
  rated_at AS "ratedAt"`;
const RATING_SPEC: readonly ColumnSpec<NewFixRating>[] = [
  { column: "run_id", get: (r) => r.runId },
  { column: "sample_artefact_id", get: (r) => r.sampleArtefactId },
  { column: "item_id", get: (r) => r.itemId },
  { column: "rater", get: (r) => r.rater },
  { column: "rater_name", get: (r) => r.raterName },
  { column: "relevant", get: (r) => r.relevant },
  { column: "placement", get: (r) => r.placement },
];

export async function insertFixRating(db: Queryable, rating: NewFixRating): Promise<FixRatingRow> {
  const [row] = await insertMany<NewFixRating, FixRatingRow>(
    db,
    "fix_ratings",
    RATING_SPEC,
    [rating],
    RATING_COLS,
  );
  return row as FixRatingRow;
}

/** Every rating row of a sample, oldest first (the latest per rater and item is the answer). */
export async function listFixRatings(db: Queryable, sampleArtefactId: Id): Promise<FixRatingRow[]> {
  const { rows } = await db.query<FixRatingRow>(
    `SELECT ${RATING_COLS} FROM fix_ratings WHERE sample_artefact_id = $1 ORDER BY id`,
    [sampleArtefactId],
  );
  return rows;
}

// ---------- audits ----------
const AUDIT_COLS = `a.run_id AS "runId", a.policy, a.options, a.status,
  a.current_stage AS "currentStage", a.error, a.created_at AS "createdAt",
  a.updated_at AS "updatedAt", s.root_url AS "rootUrl"`;
const AUDIT_FROM = `audits a JOIN runs r ON r.id = a.run_id JOIN sites s ON s.id = r.site_id`;
const STAGE_COLS = `run_id AS "runId", stage, position, status, started_at AS "startedAt",
  finished_at AS "finishedAt", duration_ms AS "durationMs", detail, error`;

/** Insert an audit for an existing run, with one pending row per stage (in order). */
export async function insertAudit(db: Queryable, audit: NewAudit): Promise<AuditRow> {
  await db.query(`INSERT INTO audits (run_id, policy, options) VALUES ($1, $2, $3::jsonb)`, [
    audit.runId,
    audit.policy,
    JSON.stringify(audit.options ?? {}),
  ]);
  if (audit.stages.length > 0) {
    await db.query(
      `INSERT INTO audit_stages (run_id, stage, position)
       SELECT $1, stage, ord::int - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(stage, ord)`,
      [audit.runId, audit.stages],
    );
  }
  return (await getAudit(db, audit.runId)) as AuditRow;
}

export function getAudit(db: Queryable, runId: Id): Promise<AuditRow | null> {
  return maybeOne(db, `SELECT ${AUDIT_COLS} FROM ${AUDIT_FROM} WHERE a.run_id = $1`, [runId]);
}

/** Newest first. */
export async function listAudits(db: Queryable): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT ${AUDIT_COLS} FROM ${AUDIT_FROM} ORDER BY a.run_id DESC`,
  );
  return rows;
}

/** Audits left `running` (e.g. by a stopped process): candidates for resuming. */
export async function listRunningAudits(db: Queryable): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT ${AUDIT_COLS} FROM ${AUDIT_FROM} WHERE a.status = 'running' ORDER BY a.run_id`,
  );
  return rows;
}

export async function setAuditStatus(
  db: Queryable,
  runId: Id,
  update: { status: AuditStatus; currentStage?: string | null; error?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE audits SET status = $2,
       current_stage = CASE WHEN $3::boolean THEN $4 ELSE current_stage END,
       error = $5, updated_at = now()
     WHERE run_id = $1`,
    [
      runId,
      update.status,
      update.currentStage !== undefined,
      update.currentStage ?? null,
      update.error ?? null,
    ],
  );
}

export async function listAuditStages(db: Queryable, runId: Id): Promise<AuditStageRow[]> {
  const { rows } = await db.query<AuditStageRow>(
    `SELECT ${STAGE_COLS} FROM audit_stages WHERE run_id = $1 ORDER BY position`,
    [runId],
  );
  return rows;
}

export async function startStage(db: Queryable, runId: Id, stage: string): Promise<void> {
  await db.query(
    `UPDATE audit_stages SET status = 'running', started_at = now(), finished_at = NULL,
       duration_ms = NULL, error = NULL
     WHERE run_id = $1 AND stage = $2`,
    [runId, stage],
  );
}

export async function finishStage(
  db: Queryable,
  runId: Id,
  stage: string,
  result: { durationMs: number; detail: { [key: string]: Json } },
): Promise<void> {
  await db.query(
    `UPDATE audit_stages SET status = 'completed', finished_at = now(), duration_ms = $3,
       detail = $4::jsonb, error = NULL
     WHERE run_id = $1 AND stage = $2`,
    [runId, stage, result.durationMs, JSON.stringify(result.detail)],
  );
}

export async function failStage(
  db: Queryable,
  runId: Id,
  stage: string,
  result: { durationMs: number; error: string },
): Promise<void> {
  await db.query(
    `UPDATE audit_stages SET status = 'failed', finished_at = now(), duration_ms = $3, error = $4
     WHERE run_id = $1 AND stage = $2`,
    [runId, stage, result.durationMs, result.error],
  );
}

/** Set the stage at `fromPosition` and every later one back to pending (to re-run them). */
export async function resetStages(db: Queryable, runId: Id, fromPosition: number): Promise<void> {
  await db.query(
    `UPDATE audit_stages SET status = 'pending', started_at = NULL, finished_at = NULL,
       duration_ms = NULL, detail = '{}'::jsonb, error = NULL
     WHERE run_id = $1 AND position >= $2`,
    [runId, fromPosition],
  );
}

// ---------- policy jobs ----------
const POLICY_JOB_COLS = `run_id AS "runId", status, done, current, error,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Start (or restart) an audit's policy job: running, nothing done yet. */
export function startPolicyJob(db: Queryable, runId: Id): Promise<PolicyJobRow> {
  return one(
    db,
    `INSERT INTO policy_jobs (run_id, status) VALUES ($1, 'running')
     ON CONFLICT (run_id) DO UPDATE SET status = 'running', done = '{}', current = NULL,
       error = NULL, updated_at = now()
     RETURNING ${POLICY_JOB_COLS}`,
    [runId],
  );
}

export async function updatePolicyJob(
  db: Queryable,
  runId: Id,
  update: {
    status: PolicyJobStatus;
    done: readonly string[];
    current: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE policy_jobs SET status = $2, done = $3::text[], current = $4, error = $5,
       updated_at = now()
     WHERE run_id = $1`,
    [runId, update.status, update.done, update.current, update.error ?? null],
  );
}

export function getPolicyJob(db: Queryable, runId: Id): Promise<PolicyJobRow | null> {
  return maybeOne(db, `SELECT ${POLICY_JOB_COLS} FROM policy_jobs WHERE run_id = $1`, [runId]);
}

/** Jobs left `running` (e.g. by a stopped process): candidates for resuming. */
export async function listRunningPolicyJobs(db: Queryable): Promise<PolicyJobRow[]> {
  const { rows } = await db.query<PolicyJobRow>(
    `SELECT ${POLICY_JOB_COLS} FROM policy_jobs WHERE status = 'running' ORDER BY run_id`,
  );
  return rows;
}

// ---------- artefacts ----------
export function insertArtefact<P extends Json>(
  db: Queryable,
  artefact: NewArtefact<P>,
): Promise<ArtefactRow<P>> {
  return one(
    db,
    `INSERT INTO artefacts (run_id, policy_version, kind, payload) VALUES ($1, $2, $3, $4::jsonb)
     RETURNING ${ARTEFACT_COLS}`,
    [artefact.runId, artefact.policyVersion, artefact.kind, JSON.stringify(artefact.payload)],
  );
}

export interface ArtefactFilter {
  policyVersion?: string;
  kind?: string;
}

export async function listArtefacts<P extends Json = Json>(
  db: Queryable,
  runId: Id,
  filter: ArtefactFilter = {},
): Promise<ArtefactRow<P>[]> {
  const { rows } = await db.query<ArtefactRow<P>>(
    `SELECT ${ARTEFACT_COLS} FROM artefacts
     WHERE run_id = $1 AND ($2::text IS NULL OR policy_version = $2)
       AND ($3::text IS NULL OR kind = $3)
     ORDER BY id`,
    [runId, filter.policyVersion ?? null, filter.kind ?? null],
  );
  return rows;
}
