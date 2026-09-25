import express, { type Express, type Request, type Response } from "express";
import {
  db as q,
  makeConfig,
  prominence,
  type canonicalise,
  type SigmaVariant,
} from "@linklens/core";
import { asyncHandler, errorHandler, HttpError } from "./errors.js";
import { DOCS_HTML, openApiDocument } from "./openapi.js";
import {
  STAGES,
  type CreateAuditInput,
  type Logger,
  type PipelineEvent,
  type Stage,
} from "./pipeline.js";
import {
  AnalyticsQuerySchema,
  CreateAuditSchema,
  DiagnosisQuerySchema,
  FixesQuerySchema,
  IdParamsSchema,
  IssuesQuerySchema,
  PolicyQuerySchema,
} from "./schemas.js";
import {
  auditView,
  diagnosisView,
  exportBundle,
  fixesView,
  graphView,
  issuesView,
  orphansView,
  requireAudit,
  sensitivityView,
  summaryView,
} from "./views.js";

/** What the routes need from the pipeline (PipelineRunner implements it; tests may stub it). */
export interface AuditService {
  readonly db: q.Queryable;
  create(input: CreateAuditInput): Promise<q.AuditRow>;
  isActive(runId: number): boolean;
  start(runId: number): Promise<void>;
  rerunFrom(runId: number, stage: Stage): Promise<void>;
  on(event: "event", listener: (e: PipelineEvent) => void): unknown;
  off(event: "event", listener: (e: PipelineEvent) => void): unknown;
}

export interface AppOptions {
  readonly service: AuditService;
  readonly logger?: Logger;
  /** Interval of SSE keep-alive comments (ms). */
  readonly heartbeatMs?: number;
}

const silent: Logger = { info: () => undefined, error: () => undefined };
const idOf = (req: Request) => IdParamsSchema.parse(req.params).id;

export function createApp(options: AppOptions): Express {
  const { service } = options;
  const logger = options.logger ?? silent;
  const db = service.db;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument());
  });
  app.get("/docs", (_req, res) => {
    res.type("html").send(DOCS_HTML);
  });

  // ---------- audits ----------

  app.post(
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
      res
        .status(202)
        .location(`/audits/${id}`)
        .json({
          id,
          status: audit.status,
          policy: audit.policy,
          links: {
            self: `/audits/${id}`,
            events: `/audits/${id}/events`,
            summary: `/audits/${id}/summary`,
          },
        });
    }),
  );

  app.get(
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

  app.get(
    "/audits/:id",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await auditView(db, a, service.isActive(a.runId)));
    }),
  );

  app.post(
    "/audits/:id/resume",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      if (service.isActive(a.runId))
        throw new HttpError(409, "running", `audit ${a.runId} is already running`);
      if (a.status === "completed")
        throw new HttpError(409, "completed", `audit ${a.runId} is already completed`);
      void service.start(a.runId);
      res.status(202).json({ id: a.runId, status: "running" });
    }),
  );

  app.get(
    "/audits/:id/events",
    asyncHandler(async (req, res) => {
      const id = idOf(req);
      await requireAudit(db, id);
      events(req, res, id);
    }),
  );

  app.get(
    "/audits/:id/summary",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await summaryView(db, a, service.isActive(a.runId)));
    }),
  );

  app.get(
    "/audits/:id/graph",
    asyncHandler(async (req, res) => {
      const { policy } = PolicyQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      res.json(await graphView(db, a, policy ?? (a.policy as canonicalise.PolicyId)));
    }),
  );

  app.get(
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

  app.get(
    "/audits/:id/diagnosis",
    asyncHandler(async (req, res) => {
      const qs = DiagnosisQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      res.json(await diagnosisView(db, a, qs.case));
    }),
  );

  app.get(
    "/audits/:id/fixes",
    asyncHandler(async (req, res) => {
      const qs = FixesQuerySchema.parse(req.query);
      const a = await requireAudit(db, idOf(req));
      const run = await q.getRun(db, a.runId);
      const config = makeConfig(run?.config ?? {});
      const sigma: SigmaVariant =
        qs.sigma ?? (a.options["sigma"] as SigmaVariant | undefined) ?? config.sigmaVariant;
      res.json(await fixesView(db, a, sigma, qs.k ?? config.fixTopK, qs.scope));
    }),
  );

  app.get(
    "/audits/:id/orphans",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await orphansView(db, a));
    }),
  );

  app.get(
    "/audits/:id/sensitivity",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      res.json(await sensitivityView(db, a));
    }),
  );

  app.post(
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
      const active = service.isActive(a.runId);
      const at = a.currentStage === null ? -1 : STAGES.indexOf(a.currentStage as Stage);
      if (active && at >= STAGES.indexOf(from)) {
        throw new HttpError(
          409,
          "running",
          `audit ${a.runId} is past ${from}; upload once it has finished`,
        );
      }
      const rows = await prominence.importAnalyticsCsv(db, a.runId, req.body, name ?? null);
      // A running audit that has not reached prominence picks the clicks up by itself.
      if (!active) await service.rerunFrom(a.runId, from);
      res.status(202).json({ id: a.runId, imported: rows.length, rerunFrom: from });
    }),
  );

  app.get(
    "/audits/:id/export",
    asyncHandler(async (req, res) => {
      const a = await requireAudit(db, idOf(req));
      const zip = await exportBundle(db, a, service.isActive(a.runId));
      res
        .type("application/zip")
        .set("Content-Disposition", `attachment; filename="linklens-audit-${a.runId}.zip"`)
        .send(Buffer.from(zip));
    }),
  );

  app.use((_req, _res, next) => next(new HttpError(404, "not_found", "no such route")));
  app.use(errorHandler(logger));

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
      service.off("event", listener);
      clearInterval(heartbeat);
      res.end();
    };
    // Subscribe before reading the status, so no event falls between the two.
    const listener = (e: PipelineEvent) => {
      if (e.runId !== id) return;
      send(e.type, e);
      if (e.type === "done") close();
    };
    service.on("event", listener);
    const heartbeat = setInterval(() => {
      if (open) res.write(": ping\n\n");
    }, options.heartbeatMs ?? 15_000);
    req.on("close", close);
    void (async () => {
      const a = await requireAudit(db, id);
      send("snapshot", await auditView(db, a, service.isActive(id)));
      if (!service.isActive(id) && (a.status === "completed" || a.status === "failed")) {
        send("done", {
          type: "done",
          runId: id,
          status: a.status,
          ...(a.error === null ? {} : { error: a.error }),
        });
        close();
      } else if (!service.isActive(id)) {
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
