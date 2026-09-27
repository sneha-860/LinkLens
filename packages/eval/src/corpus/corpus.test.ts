import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@linklens/core";
import { parseCorpus, resolveConfig, sitesByClass } from "./corpus.js";

const REAL = readFileSync(new URL("../../corpus.yaml", import.meta.url), "utf8");

const yaml = (sites: string, extra = "") => `
version: 1
seed: 7
policy: P3
sigma: refGateCosine
refVariant: weighted
${extra}
classes:
  blog: { label: Blog }
  docs: { label: Docs }
sites:
${sites}`;

const TWO = `
  - { id: a, url: "https://a.test/", architecture_class: blog, notes: " first " }
  - { id: b, url: "https://b.test/docs/", architecture_class: docs }`;

describe("corpus.yaml", () => {
  it("has 28 sites in three classes, each class used", () => {
    const c = parseCorpus(REAL);
    expect(c.sites).toHaveLength(28);
    expect(c.classes.map((x) => x.id)).toEqual([
      "cms-blog",
      "ecommerce-catalogue",
      "documentation",
    ]);
    for (const sites of sitesByClass(c).values()) expect(sites.length).toBeGreaterThanOrEqual(5);
    expect(c.sites.every((s) => s.notes !== "")).toBe(true);
    expect(c.seed).toBe(defaultConfig.randomSeed);
  });

  it("marks 10 sites for the Screaming Frog calibration (E5), from every class", () => {
    const c = parseCorpus(REAL);
    const marked = c.sites.filter((s) => s.screamingFrog);
    expect(marked).toHaveLength(10);
    expect(new Set(marked.map((s) => s.architectureClass)).size).toBe(3);
  });
});

describe("parseCorpus", () => {
  it("reads sites in file order, trims notes and hashes the file", () => {
    const text = yaml(TWO);
    const c = parseCorpus(text);
    expect(c.sites).toEqual([
      {
        id: "a",
        url: "https://a.test/",
        architectureClass: "blog",
        notes: "first",
        screamingFrog: false,
      },
      {
        id: "b",
        url: "https://b.test/docs/",
        architectureClass: "docs",
        notes: "",
        screamingFrog: false,
      },
    ]);
    expect(c.config).toEqual({});
    expect(c.rankAllPolicies).toBe(true); // the default
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseCorpus(`${text}\n# comment`).sha256).not.toBe(c.sha256);
  });

  it("reports every problem at once", () => {
    const bad = yaml(
      `
  - { id: a, url: "https://a.test/", architecture_class: blog }
  - { id: a, url: "https://a.test/", architecture_class: wiki }`,
      "config: { pageCapp: 3, randomSeed: 1 }",
    );
    const err = (() => {
      try {
        parseCorpus(bad);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("config.pageCapp is not a LinkLens config key");
    expect(err).toContain("set the seed with `seed`");
    expect(err).toContain("site id a is used twice");
    expect(err).toContain("unknown architecture_class wiki");
    expect(err).toContain("same URL");
    expect(err).toContain("class docs has no site");
  });

  it("rejects bad shapes and bad config values", () => {
    expect(() => parseCorpus(yaml(TWO).replace("policy: P3", "policy: P9"))).toThrow(/policy/);
    expect(() => parseCorpus(yaml(TWO.replace("https://a.test/", "ftp://a.test/")))).toThrow(
      /invalid corpus/,
    );
    expect(() => parseCorpus(yaml(TWO.replace("id: a", "id: A_1")))).toThrow(/invalid corpus/);
    expect(() => parseCorpus(yaml(TWO, "config: { pageCap: 0 }"))).toThrow(/pageCap/);
  });
});

describe("resolveConfig", () => {
  it("applies the overrides, the seed and a User-Agent override", () => {
    const c = parseCorpus(yaml(TWO, "config: { pageCap: 50 }"));
    const cfg = resolveConfig(c);
    expect(cfg).toMatchObject({ pageCap: 50, randomSeed: 7, userAgent: defaultConfig.userAgent });
    const ua = "TestBot/1.0 (+https://example.test/bot)";
    expect(resolveConfig(c, ua).userAgent).toBe(ua);
    expect(resolveConfig(c, "").userAgent).toBe(defaultConfig.userAgent);
  });
});
