import { EventEmitter } from "node:events";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { db as q } from "@linklens/core";
import { createApp, type AuditService } from "./app.js";
import { csvField, toCsv } from "./csv.js";
import { STAGES, type CreateAuditInput } from "./pipeline.js";

/** A service whose database is never reached in these tests (queries throw). */
function stub(create?: (input: CreateAuditInput) => Promise<q.AuditRow>) {
  const bus = new EventEmitter();
  const db: q.Queryable = {
    query: () => Promise.reject(new Error("database unavailable in unit tests")),
  };
  const service: AuditService = {
    db,
    create: create ?? (() => Promise.reject(new Error("not expected"))),
    isActive: () => false,
    start: () => Promise.resolve(),
    rerunFrom: () => Promise.resolve(),
    on: (e, l) => bus.on(e, l),
    off: (e, l) => bus.off(e, l),
  };
  const errors: string[] = [];
  const app = createApp({
    service,
    logger: { info: () => undefined, error: (m) => errors.push(m) },
  });
  return { app, errors };
}

const audit = (input: CreateAuditInput): q.AuditRow => ({
  runId: 42,
  policy: input.policy,
  options: {},
  status: "queued",
  currentStage: null,
  error: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  rootUrl: input.url,
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await request(stub().app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /audits validation", () => {
  it.each([
    [{}, "url"],
    [{ url: "not a url" }, "url"],
    [{ url: "ftp://example.com/" }, "url"],
    [{ url: "https://example.com/", pageCap: 0 }, "pageCap"],
    [{ url: "https://example.com/", pageCap: 501 }, "pageCap"],
    [{ url: "https://example.com/", policy: "P9" }, "policy"],
    [{ url: "https://example.com/", options: { sigma: "cosine" } }, "options.sigma"],
    [{ url: "https://example.com/", options: { unknown: 1 } }, "options"],
    [{ url: "https://example.com/", extra: true }, ""],
  ])("rejects %j (400, path %j)", async (body, path) => {
    const res = await request(stub().app).post("/audits").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it("rejects invalid config overrides before creating anything", async () => {
    const create = vi.fn();
    const res = await request(stub(create).app)
      .post("/audits")
      .send({ url: "https://example.com/", options: { config: { epsilon: 5 } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_config" });
    expect(res.body.error.message).toMatch(/epsilon/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await request(stub().app)
      .post("/audits")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });

  it("starts an audit: 202, Location and links (policy P3 by default)", async () => {
    const create = vi.fn((input: CreateAuditInput) => Promise.resolve(audit(input)));
    const res = await request(stub(create).app)
      .post("/audits")
      .send({ url: "https://example.com/", pageCap: 50, options: { sigma: "blended" } });
    expect(res.status).toBe(202);
    expect(res.headers["location"]).toBe("/audits/42");
    expect(res.body).toEqual({
      id: 42,
      status: "queued",
      policy: "P3",
      links: { self: "/audits/42", events: "/audits/42/events", summary: "/audits/42/summary" },
    });
    expect(create).toHaveBeenCalledWith({
      url: "https://example.com/",
      policy: "P3",
      pageCap: 50,
      options: { sigma: "blended" },
    });
  });

  it("turns a refused run (no contact URL in the User-Agent) into 400", async () => {
    const res = await request(
      stub(() => Promise.reject(new Error("config.userAgent is not identifying: no contact URL")))
        .app,
    )
      .post("/audits")
      .send({ url: "https://example.com/" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_audit" });
  });
});

describe("routing and errors", () => {
  it.each(["/audits/abc", "/audits/0", "/audits/-3/summary", "/audits/1.5/fixes"])(
    "validates the id in %s",
    async (path) => {
      const res = await request(stub().app).get(path);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    },
  );

  it.each([
    "/audits/1/fixes?k=7",
    "/audits/1/fixes?sigma=cosine",
    "/audits/1/fixes?scope=everywhere",
    "/audits/1/graph?policy=P7",
    "/audits/1/issues?severity=urgent",
    "/audits/1/diagnosis?case=v9",
    "/audits/1/fixes?unknown=1",
  ])("validates the query of %s before touching the database", async (path) => {
    const res = await request(stub().app).get(path);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("answers unknown routes with 404", async () => {
    const res = await request(stub().app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: "no such route" } });
  });

  it("hides internal errors behind 500 and logs them", async () => {
    const { app, errors } = stub();
    const res = await request(app).get("/audits");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal", message: "internal server error" } });
    expect(errors.join("\n")).toMatch(/database unavailable/);
  });
});

describe("OpenAPI", () => {
  it("documents every route, with request schemas from the validators", async () => {
    const res = await request(stub().app).get("/openapi.json");
    expect(res.status).toBe(200);
    const doc = res.body;
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        "/health",
        "/audits",
        "/audits/{id}",
        "/audits/{id}/resume",
        "/audits/{id}/events",
        "/audits/{id}/summary",
        "/audits/{id}/graph",
        "/audits/{id}/issues",
        "/audits/{id}/diagnosis",
        "/audits/{id}/fixes",
        "/audits/{id}/orphans",
        "/audits/{id}/sensitivity",
        "/audits/{id}/analytics",
        "/audits/{id}/export",
      ].sort(),
    );
    const create = doc.components.schemas.CreateAudit;
    expect(create.required).toEqual(["url"]);
    expect(create.properties.policy.enum).toEqual(["P0", "P1", "P2", "P3", "P4", "P5"]);
    const fixesParams = doc.paths["/audits/{id}/fixes"].get.parameters.map(
      (p: { name: string }) => p.name,
    );
    expect(fixesParams).toEqual(["id", "sigma", "k", "scope"]);
    expect(doc.info.description).toContain(STAGES.join(" → "));
  });

  it("serves Swagger UI", async () => {
    const res = await request(stub().app).get("/docs");
    expect(res.status).toBe(200);
    expect(res.text).toContain("SwaggerUIBundle");
  });
});

describe("CSV", () => {
  it("quotes per RFC 4180 and ends lines with CRLF", () => {
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvField(null)).toBe("");
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
    expect(
      toCsv(
        [{ n: "x\ny", v: 2 }],
        [
          ["name", (r) => r.n],
          ["value", (r) => r.v],
        ],
      ),
    ).toBe('name,value\r\n"x\ny",2\r\n');
  });
});
