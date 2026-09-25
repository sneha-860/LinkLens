import { z } from "zod";
import {
  AnalyticsQuerySchema,
  CreateAuditSchema,
  DiagnosisQuerySchema,
  FixesQuerySchema,
  IssuesQuerySchema,
  PolicyQuerySchema,
  SensitivityQuerySchema,
  EXPORT_FILES,
} from "./schemas.js";
import { STAGES } from "./pipeline.js";

type JsonSchema = Record<string, unknown>;
const schema = (s: z.ZodType, io: "input" | "output" = "input") =>
  z.toJSONSchema(s, { io, unrepresentable: "any" }) as JsonSchema;

/** Query parameters of an object schema, as OpenAPI parameters. */
function queryParams(s: z.ZodObject): JsonSchema[] {
  const js = schema(s);
  const props = (js["properties"] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((js["required"] ?? []) as string[]);
  return Object.entries(props).map(([name, p]) => ({
    name,
    in: "query",
    required: required.has(name),
    ...(typeof p["description"] === "string" ? { description: p["description"] } : {}),
    schema: p,
  }));
}

const idParam = { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } };
const error = { $ref: "#/components/schemas/Error" };
const errors = {
  "400": { description: "Invalid request", content: { "application/json": { schema: error } } },
  "404": { description: "Audit not found", content: { "application/json": { schema: error } } },
};
const notYet = {
  "409": {
    description: "The pipeline has not produced this yet",
    content: { "application/json": { schema: error } },
  },
};
const json = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

/** The OpenAPI 3.1 document of the API (request schemas generated from the zod validators). */
export function openApiDocument(): JsonSchema {
  return {
    openapi: "3.1.0",
    info: {
      title: "LinkLens API",
      version: "0.1.0",
      description:
        "Internal link auditing: crawl a site, then run the pipeline " +
        `(${STAGES.join(" → ")}). Every stage is resumable and stores its artefacts with the policy version.`,
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
            },
          },
        },
        CreateAudit: schema(CreateAuditSchema),
      },
    },
    paths: {
      "/health": { get: { summary: "Liveness", responses: { "200": json("ok") } } },
      "/audits": {
        post: {
          summary: "Start an audit",
          description: "Creates the crawl run and runs the whole pipeline in the background.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CreateAudit" } },
            },
          },
          responses: {
            "202": json("The audit (queued), with links to its status and events"),
            ...errors,
          },
        },
        get: { summary: "List audits (newest first)", responses: { "200": json("Audits") } },
      },
      "/audits/{id}": {
        get: {
          summary: "Status and progress",
          parameters: [idParam],
          responses: {
            "200": json("Status, crawl progress and every stage with its duration"),
            ...errors,
          },
        },
      },
      "/audits/{id}/resume": {
        post: {
          summary: "Resume a failed or interrupted audit from its first incomplete stage",
          parameters: [idParam],
          responses: { "202": json("Resuming"), ...errors },
        },
      },
      "/audits/{id}/events": {
        get: {
          summary: "Live progress (server-sent events)",
          description:
            "Events: snapshot (the status on connect), stage (running/completed/failed with duration), " +
            "progress (crawl pages), done (completed/failed; the stream then closes).",
          parameters: [idParam],
          responses: {
            "200": { description: "An event stream", content: { "text/event-stream": {} } },
            ...errors,
          },
        },
      },
      "/audits/{id}/summary": {
        get: {
          summary: "Headline numbers",
          parameters: [idParam],
          responses: { "200": json("Summary"), ...errors },
        },
      },
      "/audits/{id}/graph": {
        get: {
          summary: "Link graph under a policy (graphology export)",
          parameters: [idParam, ...queryParams(PolicyQuerySchema)],
          responses: { "200": json("Graph"), ...errors, ...notYet },
        },
      },
      "/audits/{id}/issues": {
        get: {
          summary: "Structural issues",
          parameters: [idParam, ...queryParams(IssuesQuerySchema)],
          responses: { "200": json("Issues"), ...errors, ...notYet },
        },
      },
      "/audits/{id}/diagnosis": {
        get: {
          summary: "Four-case diagnosis (v1–v4) with explanations",
          parameters: [idParam, ...queryParams(DiagnosisQuerySchema)],
          responses: { "200": json("Diagnosis"), ...errors, ...notYet },
        },
      },
      "/audits/{id}/fixes": {
        get: {
          summary: "Ranked fixes S(u→v) = ΔPR × σ / κ, top k, with explanations",
          parameters: [idParam, ...queryParams(FixesQuerySchema)],
          responses: { "200": json("Fixes"), ...errors, ...notYet },
        },
      },
      "/audits/{id}/orphans": {
        get: {
          summary: "Orphans with rescue donors and the channels that revealed them",
          parameters: [idParam],
          responses: { "200": json("Orphans"), ...errors, ...notYet },
        },
      },
      "/audits/{id}/sensitivity": {
        get: {
          summary: "Compare all six canonicalisation policies on this run (E1)",
          description:
            "Per policy: size, reachability, orphans, issues, mean depth; against the audit's policy " +
            "(in P3 form): Spearman of PageRank, mean depth shift and the Jaccard of the top-k fixes " +
            "(once fixes are ranked under that policy; see POST …/sensitivity/fixes).",
          parameters: [idParam, ...queryParams(SensitivityQuerySchema)],
          responses: {
            "200": json("One row per policy, and the fix-ranking job"),
            ...errors,
            ...notYet,
          },
        },
      },
      "/audits/{id}/sensitivity/fixes": {
        post: {
          summary: "Rank fixes under every other policy in the background (for the Jaccard column)",
          parameters: [idParam],
          responses: { "202": json("The job"), ...errors, ...notYet },
        },
      },
      "/audits/{id}/reconciliation": {
        get: {
          summary:
            "Discovery inventory: each URL's channels, orphans first, and each channel's yield",
          parameters: [idParam],
          responses: { "200": json("Inventory and channel statistics"), ...errors, ...notYet },
        },
      },
      "/audits/{id}/report": {
        get: {
          summary: "A printable HTML report",
          parameters: [idParam],
          responses: { "200": { description: "HTML", content: { "text/html": {} } }, ...errors },
        },
      },
      "/audits/{id}/export/{file}": {
        get: {
          summary: "One file of the export",
          parameters: [
            idParam,
            {
              name: "file",
              in: "path",
              required: true,
              schema: { type: "string", enum: [...EXPORT_FILES] },
            },
          ],
          responses: {
            "200": { description: "The file", content: { "application/json": {}, "text/csv": {} } },
            ...errors,
            ...notYet,
          },
        },
      },
      "/audits/{id}/analytics": {
        post: {
          summary: "Upload analytics clicks (CSV: source_url, target_url, clicks)",
          description: "Stores the rows raw, then re-runs the pipeline from prominence.",
          parameters: [idParam, ...queryParams(AnalyticsQuerySchema)],
          requestBody: { required: true, content: { "text/csv": { schema: { type: "string" } } } },
          responses: {
            "202": json("Rows imported; re-running from prominence"),
            ...errors,
            "409": {
              description: "The audit is past prominence and still running",
              content: { "application/json": { schema: error } },
            },
          },
        },
      },
      "/audits/{id}/export": {
        get: {
          summary: "Everything as a zip of JSON and CSV files",
          parameters: [idParam],
          responses: {
            "200": { description: "A zip archive", content: { "application/zip": {} } },
            ...errors,
          },
        },
      },
    },
  };
}

/** Swagger UI for the document (assets from the jsDelivr CDN). */
export const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>LinkLens API</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="docs"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#docs" });</script>
  </body>
</html>
`;
