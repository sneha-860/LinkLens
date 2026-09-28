import { join, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import {
  db as q,
  makeConfig,
  prominence,
  rating,
  type canonicalise,
  type SigmaVariant,
} from "@linklens/core";
import {
  clearSessionCookie,
  credential,
  requireAuth,
  safeEqual,
  setSessionCookie,
} from "./auth.js";
import { asyncHandler, errorHandler, HttpError, notReady } from "./errors.js";
import type { EventListener } from "./events.js";
import { DOCS_HTML, openApiDocument } from "./openapi.js";
import {
  STAGES,
  type CreateAuditInput,
  type Logger,
  type PipelineEvent,
  type PolicyJob,
  type Stage,
} from "./pipeline.js";
import { reportHtml } from "./report.js";
import {
  AnalyticsQuerySchema,
  CreateAuditSchema,
  DiagnosisQuerySchema,
  ExportFileParamsSchema,
  FixesQuerySchema,
  IdParamsSchema,
  IssuesQuerySchema,
  PolicyQuerySchema,
  RatingQuerySchema,
  RatingSchema,
  SensitivityQuerySchema,
  SessionSchema,
} from "./schemas.js";
import {
  auditView,
  diagnosisView,
  exportBundle,
  exportFiles,
  fixesView,
  graphView,
  issuesView,
  linksView,
  orphansView,
  ratingView,
  reconciliationView,
  requireAudit,
  sensitivityView,
  summaryView,
} from "./views.js";

/** What the routes need from the pipeline (PipelineRunner implements it; tests may stub it). */
export interface AuditService {
  readonly db: q.Queryable;
  create(input: CreateAuditInput): Promise<q.AuditRow>;
  /** Running here or in another instance. */
  isActive(runId: number): Promise<boolean>;
  start(runId: number): Promise<void>;
  /** Throws CapacityError (429) when no more audits or jobs may start. */
  assertCapacity(): void;
  rerunFrom(runId: number, stage: Stage): Promise<void>;
  policyJob(runId: number): Promise<PolicyJob | null>;
  rankAllPolicies(runId: number): Promise<PolicyJob>;
  /** Pipeline events of every instance; returns the unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Resolves once subscriptions receive events. */
  eventsReady(): Promise<void>;
}

export interface AppOptions {
  readonly service: AuditService;
  readonly logger?: Logger;
  /** Interval of SSE keep-alive comments (ms). */
  readonly heartbeatMs?: number;
  /**
   * When set, every route but /health, /openapi.json, /docs and /session needs this key (or the
   * session cookie that POST /session sets for the dashboard).
   */
  readonly apiKey?: string;
  /**
   * The built dashboard (packages/web/dist). When set, it is served at / (with the SPA fallback)
   * and the API moves under /api, as in development behind the Vite proxy.
   */
  readonly webRoot?: string;
}

const silent: Logger = { info: () => undefined, error: () => undefined };
const idOf = (req: Request) => IdParamsSchema.parse(req.params).id;

export function createApp(options: AppOptions): Express {
  const { service } = options;
  const logger = options.logger ?? silent;
  const db = service.db;
  const apiKey = options.apiKey === undefined || options.apiKey === "" ? null : options.apiKey;
  const app = express();
  app.disable("x-powered-by");
  const api = express.Router();
  api.use(express.json({ limit: "1mb" }));

  api.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  api.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument());
  });
  api.get("/docs", (_req, res) => {
    res.type("html").send(DOCS_HTML);
  });

  // ---------- session (the dashboard's sign-in) ----------

  api.get("/session", (req, res) => {
    res.json({
      authRequired: apiKey !== null,
      authenticated: apiKey === null || credential(req, apiKey) !== null,
    });
  });
  api.post("/session", (req, res) => {
    const { key } = SessionSchema.parse(req.body);
    if (apiKey === null) return void res.status(204).end();
    if (!safeEqual(key, apiKey)) throw new HttpError(401, "unauthorized", "wrong API key");
    setSessionCookie(req, res, apiKey);
    res.status(204).end();
  });
  api.delete("/session", (_req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  if (apiKey !== null) api.use(requireAuth(apiKey));

  // ---------- audits ----------

  api.post(
    "/audits",
    asyncHandler(async (req, res) => {
      const body = CreateAuditSchema.parse(req.body);
      // Validate config overrides before anything is created (makeConfig throws RangeError).
      makeConfig({
        ...(body.options.config ?? {}),
        ...(body.pageCap === undefined ? {} : { pageCap: body.pageCap }),
      });
      let audit: q.AuditRow;
      try {
        audit = await service.create({
          url: body.url,
          policy: body.policy,
          ...(body.pageCap === undefined ? {} : { pageCap: body.pageCap }),
          options: body.options as CreateAuditInput["options"] & object,
        });
      } catch (e) {
        // createRun refuses e.g. a User-Agent without a contact URL.
        const message = e instanceof Error ? e.message : String(e);
        if (/userAgent|site root|config\./.test(message))
          throw new HttpError(400, "invalid_audit", message);
        throw e;
      }
      const id = audit.runId;
      const self = `${req.baseUrl}/audits/${id}`;
      res
        .status(202)
        .location(self)
        .json({
          id,
          status: audit.status,
          policy: audit.policy,
          links: { self, events: `${self}/events`, summary: `${self}/summary` },
        });
    }),
  );

  api.get(
    "/audits",
    asyncHandler(async (_req, res) => {
      const audits = await q.listAudits(db);
      res.json({
        audits: audits.map((a) => ({
          id: a.runId,
          url: a.rootUrl,
          policy: a.policy,
          status: a.status,
          currentStage: a.currentStage,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })),
      });
    }),
  );

  api.get(
    "/audits/:id",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await auditView(db, a, await service.isActive(a.runId)));
    }),
  );

  api.post(
    "/audits/:id/resume",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      if (await service.isActive(a.runId))
        throw new HttpError(409, "running", `audit ${a.runId} is already running`);
      if (a.status === "completed")
        throw new HttpError(409, "completed", `audit ${a.runId} is already completed`);
      service.assertCapacity();
      void service.start(a.runId);
      res.status(202).json({ id: a.runId, status: "running" });
    }),
  );

  api.get(
    "/audits/:id/events",
    asyncHandler(async (req, res) => {
      const id = idOf(req);
      await requireAudit(db, id);
      events(req, res, id);
    }),
  );

  api.get(
    "/audits/:id/summary",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await summaryView(db, a, await service.isActive(a.runId)));
    }),
  );

  api.get(
    "/audits/:id/graph",
    asyncHandler(async (req, res) => {
      const { policy } = PolicyQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      res.json(await graphView(db, a, policy ?? (a.policy as canonicalise.PolicyId)));
    }),
  );

  api.get(
    "/audits/:id/issues",
    asyncHandler(async (req, res) => {
      const qs = IssuesQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      res.json(
        await issuesView(db, a, qs.policy ?? (a.policy as canonicalise.PolicyId), {
          type: qs.type,
          severity: qs.severity,
        }),
      );
    }),
  );

  api.get(
    "/audits/:id/diagnosis",
    asyncHandler(async (req, res) => {
      const qs = DiagnosisQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      res.json(await diagnosisView(db, a, qs.case));
    }),
  );

  api.get(
    "/audits/:id/fixes",
    asyncHandler(async (req, res) => {
      const qs = FixesQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      const run = await q.getRun(db, a.runId);
      const config = makeConfig(run?.config ?? {});
      const sigma: SigmaVariant =
        qs.sigma ?? (a.options["sigma"] as SigmaVariant | undefined) ?? config.sigmaVariant;
      res.json(await fixesView(db, a, sigma, qs.k ?? config.fixTopK, qs.scope, qs.scoring));
    }),
  );

  api.get(
    "/audits/:id/orphans",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await orphansView(db, a));
    }),
  );

  api.get(
    "/audits/:id/sensitivity",
    asyncHandler(async (req, res) => {
      const { k } = SensitivityQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      res.json(await sensitivityView(db, a, k, await service.policyJob(a.runId)));
    }),
  );

  api.post(
    "/audits/:id/sensitivity/fixes",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      if (a.status !== "completed" || (await service.isActive(a.runId))) {
        throw new HttpError(
          409,
          "not_ready",
          "rank fixes under other policies once the audit has completed",
        );
      }
      res.status(202).json({ id: a.runId, job: await service.rankAllPolicies(a.runId) });
    }),
  );

  api.get(
    "/audits/:id/links",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await linksView(db, a));
    }),
  );

  // ---------- E8 rating page ----------

  api.get(
    "/audits/:id/rating",
    asyncHandler(async (req, res) => {
      const { rater } = RatingQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      res.json(await ratingView(db, a, rater));
    }),
  );

  api.post(
    "/audits/:id/rating/sample",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      const policy = a.policy as canonicalise.PolicyId;
      // One sample per audit: asking again returns it (so both raters rate the same items).
      if ((await rating.loadRatingSample(db, a.runId, policy)) === null) {
        const view = await ratingView(db, a);
        if (!view.canCreate) throw notReady("fix scoring");
        await rating.buildRatingSample(
          db,
          a.runId,
          policy,
          a.options["sigma"] as SigmaVariant | undefined,
        );
        res.status(201);
      }
      res.json(await ratingView(db, a));
    }),
  );

  api.post(
    "/audits/:id/rating/answers",
    asyncHandler(async (req, res) => {
      const body = RatingSchema.parse(req.body);
      const a = await requireAudit(db, idOf(req));
      const sample = await rating.loadRatingSample(db, a.runId, a.policy as canonicalise.PolicyId);
      if (sample === null) throw notReady("the rating sample");
      const row = await rating.recordRating(db, sample, {
        itemId: body.itemId,
        rater: body.rater,
        raterName: body.name,
        relevant: body.relevant,
        placement: body.placement,
      });
      res.status(201).json({
        itemId: row.itemId,
        rater: row.rater,
        relevant: row.relevant,
        placement: row.placement,
      });
    }),
  );

  api.get(
    "/audits/:id/rating/summary",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      const sample = await rating.loadRatingSample(db, a.runId, a.policy as canonicalise.PolicyId);
      if (sample === null) throw notReady("the rating sample");
      res.json(await rating.ratingSummaryOf(db, sample));
    }),
  );

  api.get(
    "/audits/:id/reconciliation",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await reconciliationView(db, a));
    }),
  );

  api.get(
    "/audits/:id/report",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.type("html").send(await reportHtml(db, a, await service.isActive(a.runId)));
    }),
  );

  api.get(
    "/audits/:id/export/:file",
    asyncHandler(async (req, res) => {
      const { id, file } = ExportFileParamsSchema.parse(req.params);
      const a = await requireAudit(db, id);
      const bytes = (await exportFiles(db, a, await service.isActive(a.runId)))[file];
      if (bytes === undefined) throw notReady(file);
      res
        .type(file.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8")
        .set("Content-Disposition", `attachment; filename="linklens-audit-${a.runId}-${file}"`)
        .send(Buffer.from(bytes));
    }),
  );

  api.post(
    "/audits/:id/analytics",
    express.text({ type: ["text/csv", "text/plain", "application/csv"], limit: "20mb" }),
    asyncHandler(async (req, res) => {
      const { name } = AnalyticsQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      if (typeof req.body !== "string" || req.body.trim() === "") {
        throw new HttpError(
          415,
          "unsupported_media_type",
          "send the CSV as the body with Content-Type text/csv",
        );
      }
      const from: Stage = "prominence";
      const active = await service.isActive(a.runId);
      const at = a.currentStage === null ? -1 : STAGES.indexOf(a.currentStage as Stage);
      if (active && at >= STAGES.indexOf(from)) {
        throw new HttpError(
          409,
          "running",
          `audit ${a.runId} is past ${from}; upload once it has finished`,
        );
      }
      // Check capacity before importing, so a refused re-run leaves nothing half done.
      if (!active) service.assertCapacity();
      const rows = await prominence.importAnalyticsCsv(db, a.runId, req.body, name ?? null);
      // A running audit that has not reached prominence picks the clicks up by itself.
      if (!active) await service.rerunFrom(a.runId, from);
      res.status(202).json({ id: a.runId, imported: rows.length, rerunFrom: from });
    }),
  );

  api.get(
    "/audits/:id/export",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      const zip = await exportBundle(db, a, await service.isActive(a.runId));
      res
        .type("application/zip")
        .set("Content-Disposition", `attachment; filename="linklens-audit-${a.runId}.zip"`)
        .send(Buffer.from(zip));
    }),
  );

  const noRoute: express.RequestHandler = (_req, _res, next) =>
    next(new HttpError(404, "not_found", "no such route"));
  api.use(noRoute);
  api.use(errorHandler(logger));

  if (options.webRoot === undefined) {
    app.use(api);
  } else {
    const root = resolve(options.webRoot);
    app.use("/api", api);
    // Vite's assets have content hashes: cache them; index.html is revalidated every time.
    app.use(
      "/assets",
      express.static(join(root, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }),
    );
    app.use(express.static(root, { index: false }));
    // SPA fallback: the dashboard's own routes (/audits/12/fixes) get index.html.
    app.get("*", (req, res, next) => {
      if (req.accepts("html") !== "html") return next();
      res.set("Cache-Control", "no-cache").sendFile(join(root, "index.html"));
    });
    app.use(noRoute);
    app.use(errorHandler(logger));
  }

  /** Server-sent events: a snapshot, then stage/progress events until the audit is done. */
  function events(req: Request, res: Response, id: number): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let open = true;
    const send = (event: string, data: unknown) => {
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const close = () => {
      if (!open) return;
      open = false;
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    };
    // Subscribe before reading the status, so no event falls between the two.
    const listener = (e: PipelineEvent) => {
      if (e.runId !== id) return;
      send(e.type, e);
      if (e.type === "done") close();
    };
    const unsubscribe = service.subscribe(listener);
    const heartbeat = setInterval(() => {
      if (open) res.write(": ping\n\n");
    }, options.heartbeatMs ?? 15_000);
    req.on("close", close);
    void (async () => {
      await service.eventsReady();
      const a = await requireAudit(db, id);
      const active = await service.isActive(id);
      send("snapshot", await auditView(db, a, active));
      if (!active && (a.status === "completed" || a.status === "failed")) {
        send("done", {
          type: "done",
          runId: id,
          status: a.status,
          ...(a.error === null ? {} : { error: a.error }),
        });
        close();
      } else if (!active) {
        send("idle", {
          type: "idle",
          runId: id,
          status: a.status,
          hint: `POST /audits/${id}/resume`,
        });
        close();
      }
    })().catch((e: unknown) => {
      logger.error(`events ${id}: ${e instanceof Error ? e.message : String(e)}`);
      close();
    });
  }

  return app;
}
