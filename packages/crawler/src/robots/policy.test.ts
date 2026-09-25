import { describe, expect, it } from "vitest";
import { makeConfig } from "@linklens/core";
import { fetchRobots, RobotsPolicy } from "./policy.js";

const config = makeConfig({ userAgent: "LinkLensBot/0.1 (+https://example.org/bot)" });
const site = "https://www.example.com/some/page";
const fixedNow = () => new Date("2026-01-01T00:00:00Z");

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch that serves responses by URL. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined)
      return Promise.reject(new TypeError(`fetch failed: no route for ${url}`));
    return Promise.resolve(route());
  };
  return Object.assign(f, { calls }) as typeof fetch & { calls: Call[] };
}

const text =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status });
const redirect =
  (to: string, status = 301) =>
  () =>
    new Response(null, { status, headers: { location: to } });

describe("fetchRobots: status handling (RFC 9309 §2.3.1)", () => {
  it("2xx: parses and applies the file", async () => {
    const f = fakeFetch({
      "https://www.example.com/robots.txt": text("user-agent: *\ndisallow: /private"),
    });
    const { policy, record } = await fetchRobots(site, { config, fetch: f, now: fixedNow });
    expect(policy.source.kind).toBe("parsed");
    expect(policy.isAllowed("https://www.example.com/private/x")).toBe(false);
    expect(policy.isAllowed("https://www.example.com/public")).toBe(true);
    expect(record).toEqual({
      requestedUrl: "https://www.example.com/robots.txt",
      finalUrl: "https://www.example.com/robots.txt",
      statusCode: 200,
      redirectChain: [],
      fetchedAt: fixedNow(),
      error: null,
    });
  });

  it("sends the configured User-Agent and does not auto-follow redirects", async () => {
    const f = fakeFetch({ "https://www.example.com/robots.txt": text("") });
    await fetchRobots(site, { config, fetch: f });
    const init = f.calls[0]?.init;
    expect(init?.headers).toEqual({ "User-Agent": "LinkLensBot/0.1 (+https://example.org/bot)" });
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 401, 403, 404, 410, 429, 451])("%i: unavailable → allow all", async (status) => {
    const f = fakeFetch({
      "https://www.example.com/robots.txt": text("user-agent: *\ndisallow: /", status),
    });
    const { policy, record } = await fetchRobots(site, { config, fetch: f });
    expect(policy.source).toEqual({ kind: "unavailable", detail: `HTTP ${status}` });
    expect(policy.isAllowed("https://www.example.com/anything")).toBe(true);
    expect(policy.sitemaps).toEqual([]);
    expect(record.statusCode).toBe(status);
  });

  it("429 with robotsTreat429AsUnreachable: unreachable → disallow all", async () => {
    const f = fakeFetch({ "https://www.example.com/robots.txt": text("", 429) });
    const strict = makeConfig({ ...config, robotsTreat429AsUnreachable: true });
    const { policy } = await fetchRobots(site, { config: strict, fetch: f });
    expect(policy.source).toEqual({ kind: "unreachable", detail: "HTTP 429" });
    expect(policy.isAllowed("https://www.example.com/anything")).toBe(false);
  });

  it.each([500, 502, 503, 504, 599])("%i: unreachable → disallow all", async (status) => {
    const f = fakeFetch({ "https://www.example.com/robots.txt": text("", status) });
    const { policy } = await fetchRobots(site, { config, fetch: f });
    expect(policy.source.kind).toBe("unreachable");
    expect(policy.check("https://www.example.com/")).toEqual({
      allowed: false,
      rule: null,
      reason: "robots-unreachable",
    });
    expect(policy.isAllowed("https://www.example.com/robots.txt")).toBe(true);
  });

  it("network error: unreachable → disallow all, error recorded", async () => {
    const f = fakeFetch({});
    const { policy, record } = await fetchRobots(site, { config, fetch: f });
    expect(policy.source.kind).toBe("unreachable");
    expect(policy.isAllowed("https://www.example.com/")).toBe(false);
    expect(record.statusCode).toBeNull();
    expect(record.error).toMatch(/TypeError: fetch failed/);
  });

  it("timeout: unreachable → disallow all", async () => {
    const f = (() =>
      Promise.reject(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      )) as typeof fetch;
    const { policy, record } = await fetchRobots(site, { config, fetch: f });
    expect(policy.source.kind).toBe("unreachable");
    expect(record.error).toMatch(/^TimeoutError/);
  });
});

describe("fetchRobots: redirects (RFC 9309 §2.3.1.2)", () => {
  it("follows redirects (including cross-host) and applies the final file", async () => {
    const f = fakeFetch({
      "https://www.example.com/robots.txt": redirect("https://cdn.example.net/r.txt", 301),
      "https://cdn.example.net/r.txt": redirect("/robots-final.txt", 302),
      "https://cdn.example.net/robots-final.txt": text("user-agent: *\ndisallow: /x"),
    });
    const { policy, record } = await fetchRobots(site, { config, fetch: f });
    expect(policy.isAllowed("https://www.example.com/x")).toBe(false);
    expect(record.redirectChain).toEqual([
      { url: "https://www.example.com/robots.txt", statusCode: 301 },
      { url: "https://cdn.example.net/r.txt", statusCode: 302 },
    ]);
    expect(record.finalUrl).toBe("https://cdn.example.net/robots-final.txt");
  });

  it("follows exactly robotsMaxRedirects (5) hops", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 5; i++) {
      const from = i === 0 ? "https://www.example.com/robots.txt" : `https://www.example.com/r${i}`;
      routes[from] = redirect(`https://www.example.com/r${i + 1}`);
    }
    routes["https://www.example.com/r5"] = text("user-agent: *\ndisallow: /");
    const { policy } = await fetchRobots(site, { config, fetch: fakeFetch(routes) });
    expect(policy.source.kind).toBe("parsed");
  });

  it("treats more than 5 redirects as unavailable → allow all", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 6; i++) {
      const from = i === 0 ? "https://www.example.com/robots.txt" : `https://www.example.com/r${i}`;
      routes[from] = redirect(`https://www.example.com/r${i + 1}`);
    }
    routes["https://www.example.com/r6"] = text("user-agent: *\ndisallow: /");
    const { policy, record } = await fetchRobots(site, { config, fetch: fakeFetch(routes) });
    expect(policy.source).toEqual({ kind: "unavailable", detail: "more than 5 redirects" });
    expect(policy.isAllowed("https://www.example.com/x")).toBe(true);
    expect(record.redirectChain).toHaveLength(6);
  });

  it("treats a redirect loop as unavailable", async () => {
    const f = fakeFetch({ "https://www.example.com/robots.txt": redirect("/robots.txt") });
    const { policy } = await fetchRobots(site, { config, fetch: f });
    expect(policy.source.kind).toBe("unavailable");
  });

  it("treats a redirect without Location as unavailable", async () => {
    const f = fakeFetch({
      "https://www.example.com/robots.txt": () => new Response(null, { status: 302 }),
    });
    const { policy } = await fetchRobots(site, { config, fetch: f });
    expect(policy.source).toEqual({ kind: "unavailable", detail: "302 without Location" });
  });

  it("follows a redirect to a 5xx as unreachable", async () => {
    const f = fakeFetch({
      "https://www.example.com/robots.txt": redirect("https://www.example.com/r"),
      "https://www.example.com/r": text("", 503),
    });
    expect((await fetchRobots(site, { config, fetch: f })).policy.source.kind).toBe("unreachable");
  });
});

describe("fetchRobots: size limit", () => {
  it("ignores content past robotsMaxBytes", async () => {
    const pad = "#".repeat(config.robotsMaxBytes);
    const f = fakeFetch({
      "https://www.example.com/robots.txt": text(
        `user-agent: *\ndisallow: /a\n${pad}\ndisallow: /b`,
      ),
    });
    const { policy } = await fetchRobots(site, { config, fetch: f });
    expect(policy.source.kind === "parsed" && policy.source.robots.truncated).toBe(true);
    expect(policy.isAllowed("https://www.example.com/a")).toBe(false);
    expect(policy.isAllowed("https://www.example.com/b")).toBe(true);
  });
});

describe("RobotsPolicy: crawl-delay and sitemaps", () => {
  it("exposes the matched group's crawl-delay in ms", () => {
    const p = RobotsPolicy.fromText("user-agent: *\ncrawl-delay: 1.5", "LinkLensBot");
    expect(p.crawlDelayMs).toBe(1500);
  });

  it("uses only the selected groups' crawl-delay", () => {
    const robots = "user-agent: *\ncrawl-delay: 10\n\nuser-agent: linklensbot\ncrawl-delay: 2";
    expect(RobotsPolicy.fromText(robots, "LinkLensBot").crawlDelayMs).toBe(2000);
    expect(RobotsPolicy.fromText(robots, "OtherBot").crawlDelayMs).toBe(10_000);
  });

  it("takes the largest crawl-delay across merged groups", () => {
    const robots = "user-agent: a\ncrawl-delay: 2\n\nuser-agent: a\ncrawl-delay: 7";
    expect(RobotsPolicy.fromText(robots, "a").crawlDelayMs).toBe(7000);
  });

  it("is null when absent or when robots.txt was not parsed", () => {
    expect(RobotsPolicy.fromText("user-agent: *\ndisallow: /x", "a").crawlDelayMs).toBeNull();
    expect(
      new RobotsPolicy({ kind: "unavailable", detail: "HTTP 404" }, "a").crawlDelayMs,
    ).toBeNull();
  });

  it("returns sitemaps regardless of user agent", () => {
    const robots = "user-agent: otherbot\ndisallow: /\nsitemap: https://e.com/s.xml";
    expect(RobotsPolicy.fromText(robots, "LinkLensBot").sitemaps).toEqual([
      { url: "https://e.com/s.xml", line: 3 },
    ]);
  });
});
