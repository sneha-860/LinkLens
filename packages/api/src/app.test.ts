import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { db as q } from "@linklens/core";
import { createApp, type AppOptions, type AuditService } from "./app.js";
import { SESSION_COOKIE, sessionToken } from "./auth.js";
import { csvField, toCsv } from "./csv.js";
import { CapacityError } from "./errors.js";
import { LocalEventBus } from "./events.js";
import { STAGES, type CreateAuditInput } from "./pipeline.js";

/** A service whose database is never reached in these tests (queries throw). */
function stub(
  create?: (input: CreateAuditInput) => Promise<q.AuditRow>,
  options: Omit<AppOptions, "service"> & { atCapacity?: boolean } = {},
) {
  const bus = new LocalEventBus();
  const db: q.Queryable = {
    query: () => Promise.reject(new Error("database unavailable in unit tests")),
  };
  const assertCapacity = () => {
    if (options.atCapacity === true) throw new CapacityError(2);
  };
  const service: AuditService = {
    db,
    create:
      create ??
      (() => {
        assertCapacity();
        return Promise.reject(new Error("not expected"));
      }),
    isActive: () => Promise.resolve(false),
    start: () => Promise.resolve(),
    assertCapacity,
    rerunFrom: () => Promise.resolve(),
    policyJob: () => Promise.resolve(null),
    rankAllPolicies: () =>
      Promise.resolve({ status: "running", done: [], current: null, error: null }),
    subscribe: (l) => bus.subscribe(l),
    eventsReady: () => bus.ready(),
  };
  const errors: string[] = [];
  const app = createApp({
    ...options,
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

describe("API key", () => {
  const KEY = "s3cret-key";
  const { app } = stub(undefined, { apiKey: KEY });

  it("leaves health, the docs and the session routes open", async () => {
    for (const path of ["/health", "/openapi.json", "/docs"])
      expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get("/session")).body).toEqual({
      authRequired: true,
      authenticated: false,
    });
  });

  it("refuses everything else without the key (401, WWW-Authenticate)", async () => {
    for (const path of ["/audits", "/audits/1", "/audits/1/events", "/audits/1/export", "/nope"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
      expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
    }
    expect((await request(app).get("/audits").set("Authorization", "Bearer wrong")).status).toBe(
      401,
    );
    expect((await request(app).post("/audits").send({ url: "https://example.com/" })).status).toBe(
      401,
    );
  });

  it("accepts the key as a Bearer token or X-API-Key", async () => {
    // Past authentication, the stub's database fails: 500, not 401.
    expect((await request(app).get("/audits").set("Authorization", `Bearer ${KEY}`)).status).toBe(
      500,
    );
    expect((await request(app).get("/audits").set("X-API-Key", KEY)).status).toBe(500);
  });

  it("signs the dashboard in with an HttpOnly, SameSite=Strict cookie that is not the key", async () => {
    const wrong = await request(app).post("/session").send({ key: "nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const ok = await request(app).post("/session").send({ key: KEY });
    expect(ok.status).toBe(204);
    const cookie = (ok.headers["set-cookie"] as unknown as string[])[0] as string;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(KEY);
    const pair = cookie.split(";")[0] as string;
    expect(pair).toBe(`${SESSION_COOKIE}=${sessionToken(KEY)}`);
    expect((await request(app).get("/session").set("Cookie", pair)).body.authenticated).toBe(true);
    expect((await request(app).get("/audits").set("Cookie", pair)).status).toBe(500);
    // A state-changing request from another site is refused even with the cookie.
    const csrf = await request(app)
      .post("/audits/1/resume")
      .set("Cookie", pair)
      .set("Sec-Fetch-Site", "cross-site");
    expect(csrf.status).toBe(403);
    const out = await request(app).delete("/session").set("Cookie", pair);
    expect(out.status).toBe(204);
    expect((out.headers["set-cookie"] as unknown as string[])[0]).toMatch(
      /Expires=Thu, 01 Jan 1970/,
    );
  });

  it("is off without a key: the session says so", async () => {
    const open = stub().app;
    expect((await request(open).get("/session")).body).toEqual({
      authRequired: false,
      authenticated: true,
    });
    expect((await request(open).post("/session").send({ key: "x" })).status).toBe(204);
  });
});

describe("capacity", () => {
  it("refuses a new audit with 429 and Retry-After when the server is busy", async () => {
    const res = await request(stub(undefined, { atCapacity: true }).app)
      .post("/audits")
      .send({ url: "https://example.com/" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body.error).toMatchObject({ code: "too_many_audits", details: { limit: 2 } });
  });
});

describe("serving the dashboard", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "linklens-web-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>LinkLens</title>");
    writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(root, "favicon.svg"), "<svg/>");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("moves the API under /api and serves the SPA with a fallback for its routes", async () => {
    const { app } = stub(undefined, { webRoot: root });
    expect((await request(app).get("/api/health")).body).toEqual({ status: "ok" });
    expect((await request(app).get("/api/docs")).text).toContain('url: "openapi.json"');
    const page = await request(app).get("/audits/12/fixes").set("Accept", "text/html");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>LinkLens</title>");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect((await request(app).get("/").set("Accept", "text/html")).text).toContain("LinkLens");
    const asset = await request(app).get("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toMatch(/immutable/);
    expect((await request(app).get("/assets/missing.js")).status).toBe(404);
    expect((await request(app).get("/favicon.svg")).status).toBe(200);
    // The API's own 404 stays JSON; a non-HTML request outside /api is a JSON 404 too.
    const api404 = await request(app).get("/api/nope");
    expect(api404.body.error.code).toBe("not_found");
    expect((await request(app).get("/data.json").set("Accept", "application/json")).status).toBe(
      404,
    );
  });

  it("links a new audit under /api", async () => {
    const create = (input: CreateAuditInput) => Promise.resolve(audit(input));
    const res = await request(stub(create, { webRoot: root }).app)
      .post("/api/audits")
      .send({ url: "https://example.com/" });
    expect(res.status).toBe(202);
    expect(res.headers["location"]).toBe("/api/audits/42");
    expect(res.body.links.events).toBe("/api/audits/42/events");
  });

  it("keeps the dashboard's assets public but the API behind the key", async () => {
    const { app } = stub(undefined, { webRoot: root, apiKey: "k" });
    expect((await request(app).get("/audits/3").set("Accept", "text/html")).status).toBe(200);
    expect((await request(app).get("/api/audits/3")).status).toBe(401);
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
        "/session",
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
        "/audits/{id}/sensitivity/fixes",
        "/audits/{id}/reconciliation",
        "/audits/{id}/report",
        "/audits/{id}/export/{file}",
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
