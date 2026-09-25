import { describe, expect, it } from "vitest";
import { makeConfig } from "@linklens/core";
import { fetchPage, type PageFetchDeps } from "./fetcher.js";
import { RobotsPolicy } from "./robots/index.js";
import { makeScope } from "./scope.js";

const UA = "LinkLensBot/0.1 (+https://linklens.test/bot)";
const config = makeConfig({ userAgent: UA, maxRedirects: 2, maxBodyBytes: 64 });
const O = "https://site.test";

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

function harness(routes: Record<string, Route>, robotsTxt = "user-agent: *\ndisallow: /private") {
  const requested: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const throttled: string[] = [];
  const robotsChecked: string[] = [];
  const policy = RobotsPolicy.fromText(robotsTxt, UA);
  const deps: PageFetchDeps = {
    config,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      requested.push(url);
      inits.push(init);
      const route = routes[url];
      if (route === undefined) return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(route(init));
    }) as typeof fetch,
    throttle: {
      acquire: (u: URL) => {
        throttled.push(u.toString());
        return Promise.resolve(0);
      },
    },
    robots: (u: URL) => {
      robotsChecked.push(u.toString());
      return Promise.resolve(policy);
    },
    inScope: makeScope(new URL(O), false),
  };
  return { deps, requested, inits, throttled, robotsChecked };
}

const html =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const redirect =
  (to: string, status = 301) =>
  () =>
    new Response(null, { status, headers: { location: to } });

describe("fetchPage", () => {
  it("fetches a page with the configured UA, manual redirects and a timeout signal", async () => {
    const h = harness({ [`${O}/`]: html("<p>hi</p>") });
    const o = await fetchPage(new URL(`${O}/`), h.deps);
    expect(o).toMatchObject({
      kind: "ok",
      requestedUrl: `${O}/`,
      finalUrl: `${O}/`,
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
      bytes: 9,
      html: "<p>hi</p>",
      redirectChain: [],
      error: null,
      retryable: false,
    });
    expect(o.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(h.inits[0]).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA },
    });
    expect(h.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("follows redirects, recording every hop, and checks robots + throttle before each request", async () => {
    const h = harness({
      [`${O}/a`]: redirect("/b", 302),
      [`${O}/b`]: redirect(`${O}/c`, 308),
      [`${O}/c`]: html("<p>c</p>"),
    });
    const o = await fetchPage(new URL(`${O}/a`), h.deps);
    expect(o.finalUrl).toBe(`${O}/c`);
    expect(o.redirectChain).toEqual([
      { url: `${O}/a`, statusCode: 302, location: "/b" },
      { url: `${O}/b`, statusCode: 308, location: `${O}/c` },
    ]);
    expect(h.requested).toEqual([`${O}/a`, `${O}/b`, `${O}/c`]);
    expect(h.robotsChecked).toEqual(h.requested);
    expect(h.throttled).toEqual(h.requested);
  });

  it("does not request a URL disallowed by robots.txt", async () => {
    const h = harness({});
    const o = await fetchPage(new URL(`${O}/private/x`), h.deps);
    expect(o).toMatchObject({
      kind: "blocked",
      statusCode: null,
      finalUrl: null,
      retryable: false,
    });
    expect(o.error).toBe(
      `blocked by robots.txt: ${O}/private/x: disallow /private (robots.txt line 2)`,
    );
    expect(h.requested).toEqual([]);
    expect(h.throttled).toEqual([]);
  });

  it("stops at a redirect into a disallowed path without requesting it", async () => {
    const h = harness({ [`${O}/go`]: redirect("/private/x") });
    const o = await fetchPage(new URL(`${O}/go`), h.deps);
    expect(o).toMatchObject({ kind: "blocked", statusCode: 301, finalUrl: `${O}/go` });
    expect(h.requested).toEqual([`${O}/go`]);
  });

  it("reports robots.txt unreachable as a block", async () => {
    const h = harness({});
    const unreachable = new RobotsPolicy({ kind: "unreachable", detail: "HTTP 503" }, UA);
    const o = await fetchPage(new URL(`${O}/`), {
      ...h.deps,
      robots: () => Promise.resolve(unreachable),
    });
    expect(o.error).toMatch(/robots\.txt unreachable/);
  });

  it("does not follow a redirect off-site", async () => {
    const h = harness({ [`${O}/out`]: redirect("https://other.test/") });
    const o = await fetchPage(new URL(`${O}/out`), h.deps);
    expect(o).toMatchObject({
      kind: "off-site-redirect",
      statusCode: 301,
      error: "redirect leaves crawl scope: https://other.test/",
    });
    expect(h.requested).toEqual([`${O}/out`]);
  });

  it("gives up after maxRedirects", async () => {
    const h = harness({
      [`${O}/1`]: redirect("/2"),
      [`${O}/2`]: redirect("/3"),
      [`${O}/3`]: redirect("/4"),
    });
    const o = await fetchPage(new URL(`${O}/1`), h.deps);
    expect(o).toMatchObject({ kind: "too-many-redirects", error: "more than 2 redirects" });
    expect(o.redirectChain).toHaveLength(3);
  });

  it.each([
    ["mailto:x@y.z", /non-http\(s\) Location/],
    ["http://[bad", /unparsable Location/],
  ])("rejects a bad Location %s", async (location, error) => {
    const h = harness({ [`${O}/r`]: redirect(location) });
    const o = await fetchPage(new URL(`${O}/r`), h.deps);
    expect(o.kind).toBe("bad-redirect");
    expect(o.error).toMatch(error);
  });

  it("treats a 3xx without Location as final", async () => {
    const h = harness({ [`${O}/r`]: () => new Response(null, { status: 302 }) });
    const o = await fetchPage(new URL(`${O}/r`), h.deps);
    expect(o).toMatchObject({
      kind: "ok",
      statusCode: 302,
      redirectChain: [{ url: `${O}/r`, statusCode: 302, location: null }],
    });
  });

  it("marks 5xx retryable and 4xx not", async () => {
    const h = harness({ [`${O}/5`]: html("x", 503), [`${O}/4`]: html("x", 404) });
    expect((await fetchPage(new URL(`${O}/5`), h.deps)).retryable).toBe(true);
    const notFound = await fetchPage(new URL(`${O}/4`), h.deps);
    expect(notFound).toMatchObject({ retryable: false, statusCode: 404, html: null });
  });

  it("marks network errors and timeouts retryable", async () => {
    const h = harness({
      [`${O}/t`]: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    const net = await fetchPage(new URL(`${O}/nowhere`), h.deps);
    expect(net).toMatchObject({ kind: "network-error", retryable: true, statusCode: null });
    const timeout = await fetchPage(new URL(`${O}/t`), h.deps);
    expect(timeout.error).toMatch(/TimeoutError/);
    expect(timeout.retryable).toBe(true);
  });

  it("records non-HTML without decoding it", async () => {
    const h = harness({
      [`${O}/i.png`]: () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    });
    const o = await fetchPage(new URL(`${O}/i.png`), h.deps);
    expect(o).toMatchObject({ kind: "ok", contentType: "image/png", bytes: 3, html: null });
  });

  it("caps the body at maxBodyBytes and says so", async () => {
    const h = harness({ [`${O}/big`]: html("x".repeat(1000)) });
    const o = await fetchPage(new URL(`${O}/big`), h.deps);
    expect(o.bytes).toBe(64);
    expect(o.html).toHaveLength(64);
    expect(o.error).toBe("body truncated at 64 bytes");
  });

  it("returns cancelled without requesting when already aborted", async () => {
    const h = harness({ [`${O}/`]: html("x") });
    const ac = new AbortController();
    ac.abort();
    const o = await fetchPage(new URL(`${O}/`), { ...h.deps, signal: ac.signal });
    expect(o.kind).toBe("cancelled");
    expect(h.requested).toEqual([]);
  });

  it("returns cancelled when aborted mid-request", async () => {
    const ac = new AbortController();
    const h = harness({
      [`${O}/`]: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          ac.abort();
        }),
    });
    const o = await fetchPage(new URL(`${O}/`), { ...h.deps, signal: ac.signal });
    expect(o.kind).toBe("cancelled");
  });
});
