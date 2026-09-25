import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "@linklens/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey, EmbeddingCache, modelSlug } from "./cache.js";
import { EmbeddingEngine, type Extractor } from "./engine.js";
import { embeddingOptions, type EmbeddingOptions } from "./options.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "linklens-emb-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Whitespace tokenizer; the "embedding" is a normalised letter histogram over a–d. */
function fakeExtractor(): Extractor & { calls: string[][] } {
  const vocab: string[] = [];
  const calls: string[][] = [];
  const f = (async (texts: string[]) => {
    calls.push(texts);
    const data: number[] = [];
    for (const t of texts) {
      const h = [..."abcd"].map((c) => [...t].filter((x) => x === c).length + 0.5);
      const n = Math.hypot(...h);
      data.push(...h.map((x) => x / n));
    }
    return { dims: [texts.length, 4], data: Float32Array.from(data) };
  }) as unknown as Extractor & { calls: string[][] };
  f.calls = calls;
  f.tokenizer = {
    encode: (text) =>
      text
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => (vocab.includes(w) ? vocab.indexOf(w) : vocab.push(w) - 1)),
    decode: (ids) => ids.map((i) => vocab[i]).join(" "),
  };
  return f;
}

const opts = (o: Partial<EmbeddingOptions> = {}): EmbeddingOptions => ({
  ...embeddingOptions(makeConfig(), dir),
  ...o,
});

describe("cacheKey", () => {
  const base = { model: "m", dtype: "fp32" as const, bodyTokens: 256 };
  const req = { title: "Whales", body: "Big animals." };

  it("is a stable SHA-256 of model, settings and content", () => {
    expect(cacheKey(base, req)).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(base, { ...req })).toBe(cacheKey(base, req));
  });

  it("changes with the model, dtype, body tokens, title or body", () => {
    const k = cacheKey(base, req);
    for (const other of [
      cacheKey({ ...base, model: "m2" }, req),
      cacheKey({ ...base, dtype: "q8" }, req),
      cacheKey({ ...base, bodyTokens: 128 }, req),
      cacheKey(base, { ...req, title: "Whale" }),
      cacheKey(base, { ...req, body: "Big animals" }),
      cacheKey(base, { title: "Whales\n", body: "Big animals." }),
    ]) {
      expect(other).not.toBe(k);
    }
  });
});

describe("EmbeddingCache", () => {
  it("round-trips float32 vectors, under the model's own directory", async () => {
    const cache = new EmbeddingCache(dir, { model: "Xenova/all-MiniLM-L6-v2", dtype: "fp32" });
    const key = "ab".padEnd(64, "0");
    const v = Float32Array.from([0.1, -2.5, 3e-8, 1]);
    expect(await cache.get(key)).toBeNull();
    await cache.set(key, v);
    expect(await cache.get(key)).toEqual(v);
    expect(cache.path(key)).toContain(join("Xenova__all-MiniLM-L6-v2", "fp32", "ab"));
    expect(await readdir(join(cache.path(key), ".."))).toEqual([`${key}.f32`]); // no temp files left
  });

  it("ignores a corrupt or wrongly sized entry", async () => {
    const cache = new EmbeddingCache(dir, { model: "m", dtype: "fp32" });
    const key = "cd".padEnd(64, "0");
    await cache.set(key, Float32Array.from([1, 2]));
    expect(await cache.get(key, 3)).toBeNull();
    await writeFile(cache.path(key), Buffer.from([1, 2, 3]));
    expect(await cache.get(key)).toBeNull();
  });

  it("slugs model ids into one path segment", () => {
    expect(modelSlug("Xenova/all-MiniLM-L6-v2")).toBe("Xenova__all-MiniLM-L6-v2");
    expect(modelSlug("a/../b")).toBe("a__..__b");
  });
});

describe("EmbeddingEngine", () => {
  it("embeds title + the first N body tokens", () => {
    const x = fakeExtractor();
    const req = { title: "Title here", body: "one two three four five" };
    expect(EmbeddingEngine.inputText(x, req, 3)).toBe("Title here\none two three");
    expect(EmbeddingEngine.inputText(x, req, 5)).toBe("Title here\none two three four five");
    expect(EmbeddingEngine.inputText(x, { title: "", body: "a b" }, 5)).toBe("a b");
    expect(EmbeddingEngine.inputText(x, { title: "T", body: "" }, 5)).toBe("T");
  });

  it("computes misses in batches, then serves re-runs from the disk cache without the model", async () => {
    const x = fakeExtractor();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return x;
    };
    const requests = [
      { title: "aaa", body: "b" },
      { title: "ccc", body: "d" },
      { title: "abcd", body: "" },
    ];
    const first = await new EmbeddingEngine(opts({ batchSize: 2 }), load).embed(requests);
    expect(first).toMatchObject({ hits: 0, misses: 3, dimensions: 4 });
    expect(x.calls.map((c) => c.length)).toEqual([2, 1]);
    for (const v of first.vectors) expect(Math.hypot(...v)).toBeCloseTo(1, 6);

    // A fresh engine (a new process) over the same cache: no model load, identical vectors.
    const again = await new EmbeddingEngine(opts({ batchSize: 2 }), load).embed(requests);
    expect(again).toMatchObject({ hits: 3, misses: 0, keys: first.keys });
    expect(again.vectors).toEqual(first.vectors);
    expect(loads).toBe(1);
  });

  it("embeds duplicate requests once, and each vector owns its buffer", async () => {
    const x = fakeExtractor();
    const r = { title: "abc", body: "d" };
    const out = await new EmbeddingEngine(opts(), async () => x).embed([
      r,
      { title: "b", body: "" },
      r,
    ]);
    expect(x.calls).toEqual([["abc\nd", "b"]]);
    expect(out.vectors[2]).toEqual(out.vectors[0]);
    expect(out.misses).toBe(3);
    expect(out.vectors[0]?.buffer).not.toBe(out.vectors[1]?.buffer);
  });

  it("misses when the body-token setting changes", async () => {
    const x = fakeExtractor();
    const r = [{ title: "a", body: "b c d" }];
    await new EmbeddingEngine(opts({ bodyTokens: 256 }), async () => x).embed(r);
    const short = await new EmbeddingEngine(opts({ bodyTokens: 1 }), async () => x).embed(r);
    expect(short.misses).toBe(1);
    expect(x.calls.at(-1)).toEqual(["a\nb"]);
  });

  it("retries loading the model after a failed load", async () => {
    let attempt = 0;
    const engine = new EmbeddingEngine(opts(), async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("offline");
      return fakeExtractor();
    });
    await expect(engine.embed([{ title: "a", body: "" }])).rejects.toThrow("offline");
    await expect(engine.embed([{ title: "a", body: "" }])).resolves.toMatchObject({ misses: 1 });
  });

  it("returns nothing for no requests without loading the model", async () => {
    const engine = new EmbeddingEngine(opts(), () => Promise.reject(new Error("must not load")));
    expect(await engine.embed([])).toEqual({
      vectors: [],
      keys: [],
      dimensions: 0,
      hits: 0,
      misses: 0,
    });
  });
});
