import { describe, expect, it } from "vitest";
import { buildCanonicalContext, observationsFromRows } from "./build.js";
import { EMPTY_CONTEXT } from "./context.js";
import {
  isTrackingParam,
  p0,
  p1,
  p2,
  p3,
  p4,
  p5,
  POLICIES,
  POLICY_IDS,
  sameSite,
} from "./policies.js";

const E = EMPTY_CONTEXT;
type Row = readonly [input: string, expected: string, note?: string];
const table = (rows: readonly Row[]) => rows.map(([i, e, n]) => [n ?? i, i, e] as const);

// ---------------------------------------------------------------------------------------------
describe("P0: RFC 3986 syntactic normalisation", () => {
  it.each(
    table([
      ["HTTP://Example.COM/a", "http://example.com/a", "lower-cases scheme and host"],
      ["http://example.com/About/Us", "http://example.com/About/Us", "keeps path case"],
      ["http://example.com/?Q=A", "http://example.com/?Q=A", "keeps query case"],
      ["http://example.com:80/a", "http://example.com/a", "drops default http port"],
      ["https://example.com:443/a", "https://example.com/a", "drops default https port"],
      ["http://example.com:443/a", "http://example.com:443/a", "keeps a non-default port"],
      ["https://example.com:/a", "https://example.com/a", "drops an empty port"],
      ["http://example.com", "http://example.com/", "empty http path becomes /"],
      ["http://example.com/a/./b/../c", "http://example.com/a/c", "removes dot-segments"],
      ["http://example.com/%2E%2E/x", "http://example.com/x", "decoded %2E dots are dot-segments"],
      ["http://example.com/%7euser/%7E", "http://example.com/~user/~", "decodes unreserved ~"],
      [
        "http://example.com/%61%62%2d",
        "http://example.com/ab-",
        "decodes unreserved letters and -",
      ],
      [
        "http://example.com/a%2fb",
        "http://example.com/a%2Fb",
        "keeps reserved %2F encoded, upper hex",
      ],
      ["http://example.com/%c3%bc", "http://example.com/%C3%BC", "upper-cases other escapes"],
      ["http://example.com/ü", "http://example.com/%C3%BC", "IRI ü == %C3%BC"],
      ["http://example.com/a b", "http://example.com/a%20b", "encodes a literal space"],
      ["http://example.com/100%", "http://example.com/100%", "leaves a bare %"],
      [
        "http://example.com/a#Sec%7e",
        "http://example.com/a#Sec~",
        "keeps and normalises the fragment",
      ],
      ["HTTP://User@Example.COM:80", "http://User@example.com/", "keeps userinfo case"],
      ["http://[2001:DB8::1]:80/", "http://[2001:db8::1]/", "IPv6 literal"],
      [
        "http://EXAMPLE.com%2Ecom/",
        "http://example.com.com/",
        "decodes %2E in host, then lower-cases",
      ],
      ["mailto:HI@Example.COM", "mailto:HI@Example.COM", "non-http: only scheme case"],
    ]),
  )("%s", (_n, input, expected) => {
    expect(p0(input, E)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
describe("P1: P0 + drop fragment + unify trailing slash", () => {
  it.each(
    table([
      ["http://example.com/a#frag", "http://example.com/a", "drops the fragment"],
      ["http://example.com/a#", "http://example.com/a", "drops an empty fragment"],
      ["http://example.com/blog/", "http://example.com/blog", "removes the trailing slash"],
      ["http://example.com/blog//", "http://example.com/blog", "removes repeated trailing slashes"],
      ["http://example.com/", "http://example.com/", "keeps the root slash"],
      ["http://example.com", "http://example.com/", "empty path is the root"],
      ["http://example.com/blog/?x=1", "http://example.com/blog?x=1", "slash before a query"],
      ["http://example.com/blog/#top", "http://example.com/blog", "slash and fragment"],
      ["HTTP://EXAMPLE.com:80/Blog/#x", "http://example.com/Blog", "P0 still applies"],
      ["http://example.com/a?", "http://example.com/a?", "keeps an empty query (P2 drops it)"],
      [
        "http://example.com/%2F",
        "http://example.com/%2F",
        "an encoded slash is not a trailing slash",
      ],
    ]),
  )("%s", (_n, input, expected) => {
    expect(p1(input, E)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
describe("P2: P1 + strip tracking params + sort the rest", () => {
  it.each(
    table([
      ["http://e.com/a?utm_source=x&utm_medium=y", "http://e.com/a", "only utm_* → no query"],
      ["http://e.com/a?b=2&a=1", "http://e.com/a?a=1&b=2", "sorts by name"],
      ["http://e.com/a?gclid=1&x=1&fbclid=2", "http://e.com/a?x=1", "gclid, fbclid"],
      ["http://e.com/a?mc_cid=1&mc_eid=2&page=3", "http://e.com/a?page=3", "mc_*"],
      ["http://e.com/a?ref=nav", "http://e.com/a", "ref"],
      [
        "http://e.com/a?referrer=x&ref_src=y",
        "http://e.com/a?ref_src=y&referrer=x",
        "ref only exact",
      ],
      [
        "http://e.com/a?UTM_Source=x&Gclid=1",
        "http://e.com/a",
        "names compared case-insensitively",
      ],
      [
        "http://e.com/a?utm%5Fsource=x&q=1",
        "http://e.com/a?q=1",
        "%5F decoded by P0 → utm_ matched",
      ],
      ["http://e.com/a?a=2&c&a=1", "http://e.com/a?a=2&a=1&c", "stable: repeated names keep order"],
      ["http://e.com/a?&&a=1&", "http://e.com/a?a=1", "drops empty parameters"],
      ["http://e.com/a?", "http://e.com/a", "drops an empty query"],
      ["http://e.com/a/?q=a%20b&ref=x#f", "http://e.com/a?q=a%20b", "P1 and P0 still apply"],
      ["http://e.com/a?q=%7e", "http://e.com/a?q=~", "values are percent-normalised"],
    ]),
  )("%s", (_n, input, expected) => {
    expect(p2(input, E)).toBe(expected);
  });

  it.each([
    ["utm_campaign", true],
    ["UTM_x", true],
    ["mc_eid", true],
    ["gclid", true],
    ["fbclid", true],
    ["ref", true],
    ["refer", false],
    ["utm", false],
    ["page", false],
  ])("isTrackingParam(%s) → %s", (name, expected) => {
    expect(isTrackingParam(name)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
describe("P3: P2 + drop the query + http/https and www/non-www are one host", () => {
  it.each(
    table([
      ["http://www.example.com/a?x=1", "https://example.com/a", "all three unified"],
      ["https://example.com/a", "https://example.com/a", "already canonical"],
      [
        "HTTP://WWW.Example.com:80/Blog/?utm_x=1#f",
        "https://example.com/Blog",
        "everything below too",
      ],
      ["https://www.example.com:8443/", "https://example.com:8443/", "keeps a non-default port"],
      ["https://blog.example.com/", "https://blog.example.com/", "only www. is stripped"],
      ["https://www2.example.com/", "https://www2.example.com/", "www2 is a different host"],
      ["http://www.com/", "https://www.com/", "www.com is not www + com"],
      ["https://example.com/?page=2", "https://example.com/", "drops the whole query"],
      ["mailto:a@www.example.com?subject=x", "mailto:a@www.example.com", "non-http: query only"],
      ["http://www.example.com/%7Ea", "https://example.com/~a", "percent-normalised path"],
    ]),
  )("%s", (_n, input, expected) => {
    expect(p3(input, E)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
describe("P4: P3 + follow recorded redirects", () => {
  const ctx = buildCanonicalContext(
    {
      redirects: [
        ["http://e.com/old", "http://e.com/new"],
        ["http://e.com/a", "http://e.com/b"],
        ["http://e.com/b", "/c"].map((u, i) => (i === 1 ? `http://e.com${u}` : u)) as [
          string,
          string,
        ],
        ["http://e.com/x", "http://e.com/y"],
        ["http://e.com/y", "http://e.com/x"],
        ["http://e.com/out", "https://other.test/landing"],
        ["http://e.com/blog", "http://e.com/blog/"], // becomes a self-edge under P3: ignored
        ["http://e.com/m", "http://e.com/q"],
        ["http://e.com/m", "http://e.com/p"],
        ["http://e.com/m", "http://e.com/p"],
        ["http://e.com/t", "http://e.com/t2"],
        ["http://e.com/t", "http://e.com/t1"],
      ],
    },
    { maxCanonicalHops: 3 },
  );

  it.each(
    table([
      ["http://e.com/old", "https://e.com/new", "one redirect"],
      ["http://e.com/a", "https://e.com/c", "follows a chain a → b → c"],
      ["http://e.com/b", "https://e.com/c", "from the middle of the chain"],
      ["http://e.com/x", "https://e.com/x", "loop x ↔ y: smallest node on the loop"],
      ["http://e.com/y", "https://e.com/x", "loop from the other side, same node"],
      ["http://www.e.com/old/?utm_source=z#f", "https://e.com/new", "matches through P3"],
      ["http://e.com/out", "https://other.test/landing", "off-site redirect is followed"],
      ["http://e.com/blog", "https://e.com/blog", "slash-only redirect is a no-op"],
      ["http://e.com/m", "https://e.com/p", "conflicting redirects: most observed wins"],
      ["http://e.com/t", "https://e.com/t1", "tie: smallest target wins"],
      ["http://e.com/none", "https://e.com/none", "no redirect: P3"],
    ]),
  )("%s", (_n, input, expected) => {
    expect(p4(input, ctx)).toBe(expected);
  });

  it("does not depend on observation order", () => {
    const edges: [string, string][] = [
      ["http://e.com/m", "http://e.com/q"],
      ["http://e.com/m", "http://e.com/p"],
      ["http://e.com/t", "http://e.com/t2"],
      ["http://e.com/t", "http://e.com/t1"],
    ];
    const a = buildCanonicalContext({ redirects: edges }, { maxCanonicalHops: 3 });
    const b = buildCanonicalContext({ redirects: [...edges].reverse() }, { maxCanonicalHops: 3 });
    expect([...a.redirects]).toEqual([...b.redirects]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("P5: P4 + follow rel=canonical (same-site, fetched OK), guarded", () => {
  const S = "https://e.com";
  const ctx = buildCanonicalContext(
    {
      redirects: [
        [`${S}/old-canon`, `${S}/new-canon`],
        [`${S}/r`, `${S}/p`],
      ],
      canonicals: [
        [`${S}/a`, "/b"], // relative href, resolved against the page
        [`${S}/unfetched`, "/nowhere"], // target never fetched OK
        [`${S}/cross`, "https://other.test/b"], // cross-host
        [`${S}/wwwvariant`, "http://www.e.com/b"], // same site under P3
        [`${S}/self`, "https://e.com/self/"], // self-canonical (after P1)
        [`${S}/cy1`, "/cy2"], // cycle cy1 ↔ cy2
        [`${S}/cy2`, "/cy1"],
        [`${S}/into-cycle`, "/cy1"],
        [`${S}/c1`, "/c2"], // chain c1 → c2 → c3 → c4 → c5 (4 hops)
        [`${S}/c2`, "/c3"],
        [`${S}/c3`, "/c4"],
        [`${S}/c4`, "/c5"],
        [`${S}/to-redirect`, "/old-canon"], // canonical target that redirects
        [`${S}/p`, "/q"], // page reached via redirect /r → /p
        [`${S}/h1`, "/h2"], // valid hop, then a cross-host hop
        [`${S}/h2`, "https://other.test/x"],
        [`${S}/gone`, "/404"], // target fetched with a 404
      ],
      fetchedOk: [
        ...["/b", "/cy1", "/cy2", "/c2", "/c3", "/c4", "/c5", "/new-canon", "/q", "/h2"].map(
          (p) => S + p,
        ),
        "https://other.test/b",
        "https://other.test/x",
      ],
    },
    { maxCanonicalHops: 3 },
  );

  it.each(
    table([
      [`${S}/a`, `${S}/b`, "follows a valid same-site canonical"],
      [`${S}/a?utm_source=x`, `${S}/b`, "through P4 first"],
      [`${S}/unfetched`, `${S}/unfetched`, "ignores a canonical never fetched OK"],
      [`${S}/gone`, `${S}/gone`, "ignores a canonical whose target is 404"],
      [`${S}/cross`, `${S}/cross`, "ignores a cross-host canonical"],
      [`${S}/wwwvariant`, `${S}/b`, "www./http variant is the same site"],
      [`${S}/self`, `${S}/self`, "self-canonical"],
      [`${S}/cy1`, `${S}/cy1`, "cycle: a node on it keeps itself"],
      [`${S}/cy2`, `${S}/cy2`, "cycle: the other node keeps itself too"],
      [`${S}/into-cycle`, `${S}/cy1`, "pointing into a cycle: its entry node"],
      [`${S}/c2`, `${S}/c5`, "chain of 3 hops (= max) is followed"],
      [`${S}/c1`, `${S}/c1`, "chain of 4 hops (> max) is not trusted"],
      [`${S}/to-redirect`, `${S}/new-canon`, "canonical target that redirects"],
      [`${S}/r`, `${S}/q`, "page reached through a redirect"],
      [`${S}/h1`, `${S}/h2`, "stops before an invalid (cross-host) hop"],
      [`${S}/no-canonical`, `${S}/no-canonical`, "no canonical: P4"],
    ]),
  )("%s", (_n, input, expected) => {
    expect(p5(input, ctx)).toBe(expected);
  });

  it("builds the same context from stored fetch/page rows", () => {
    const rowCtx = buildCanonicalContext(
      observationsFromRows(
        [
          {
            requestedUrl: `${S}/r`,
            finalUrl: `${S}/p`,
            statusCode: 200,
            redirectChain: [{ url: `${S}/r`, statusCode: 301, location: "/p" }],
          },
          { requestedUrl: `${S}/q`, finalUrl: `${S}/q`, statusCode: 200, redirectChain: [] },
          { requestedUrl: `${S}/404`, finalUrl: `${S}/404`, statusCode: 404, redirectChain: [] },
          { requestedUrl: `${S}/x`, finalUrl: null, statusCode: null, redirectChain: [] },
        ],
        [
          { url: `${S}/p`, metaCanonical: "/q" },
          { url: `${S}/q`, metaCanonical: null },
          { url: `${S}/z`, metaCanonical: "/404" },
        ],
      ),
      { maxCanonicalHops: 3 },
    );
    expect(p5(`${S}/r`, rowCtx)).toBe(`${S}/q`);
    expect(p5(`${S}/z`, rowCtx)).toBe(`${S}/z`);
    expect([...rowCtx.fetchedOk].sort()).toEqual([`${S}/p`, `${S}/q`]);
  });

  it("sameSite compares P3 node origins", () => {
    expect(sameSite("https://e.com/a", "https://e.com/b")).toBe(true);
    expect(sameSite("https://e.com/a", "https://e.com:8443/b")).toBe(false);
    expect(sameSite("https://e.com/a", "https://blog.e.com/b")).toBe(false);
    expect(sameSite("mailto:a@b", "mailto:a@b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("all policies", () => {
  const samples = [
    "HTTP://WWW.Example.COM:80/A/./b/../c/?utm_source=x&b=2&a=1#frag",
    "https://example.com/c?a=1&b=2",
    "http://example.com/%7Euser/ü",
    "https://example.com/~user/%C3%BC/",
    "https://blog.example.com/",
    "mailto:someone@example.com",
    "http://example.com",
  ];
  const ctx = buildCanonicalContext(
    {
      redirects: [["https://example.com/c", "https://example.com/d"]],
      canonicals: [["https://example.com/d", "/e"]],
      fetchedOk: ["https://example.com/e"],
    },
    { maxCanonicalHops: 3 },
  );

  it("export a unique, well-formed version per policy", () => {
    const versions = POLICY_IDS.map((id) => POLICIES[id].version);
    for (const [i, v] of versions.entries())
      expect(v).toMatch(new RegExp(`^P${i}@\\d+\\.\\d+\\.\\d+$`));
    expect(new Set(versions).size).toBe(6);
  });

  it.each(POLICY_IDS)("%s is idempotent", (id) => {
    const f = POLICIES[id].canonicalise;
    for (const u of samples) expect(f(f(u, ctx), ctx)).toBe(f(u, ctx));
  });

  it.each(POLICY_IDS.slice(1))("%s is at least as coarse as the policy before it", (id) => {
    const prev = POLICIES[POLICY_IDS[POLICY_IDS.indexOf(id) - 1] as typeof id].canonicalise;
    const cur = POLICIES[id].canonicalise;
    for (const u of samples) {
      for (const v of samples) {
        if (prev(u, ctx) === prev(v, ctx)) expect(cur(u, ctx)).toBe(cur(v, ctx));
      }
    }
  });

  it("merge progressively more of the sample URLs", () => {
    const counts = POLICY_IDS.map(
      (id) => new Set(samples.map((u) => POLICIES[id].canonicalise(u, ctx))).size,
    );
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(counts[0]).toBeGreaterThan(counts[5] ?? 0);
  });
});
