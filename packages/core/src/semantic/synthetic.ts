import { mulberry32 } from "../graph/random.js";
import type { RawDocument } from "../text/model.js";

export interface SyntheticSiteOptions {
  readonly pages: number;
  readonly vocabulary: number;
  readonly bodyWords: number;
  readonly anchors: number;
  readonly seed: number;
}

/**
 * A seeded synthetic site for tests and benchmarks: letter-only made-up words with a skewed
 * (Zipf-like) frequency, a shared boilerplate sentence, and per-page title, anchors and body.
 */
export function syntheticSite(o: SyntheticSiteOptions): RawDocument[] {
  const random = mulberry32(o.seed);
  const letters = "bcdfghjklmnpqrstvwxz";
  const word = (i: number) => {
    let s = "";
    for (let x = i + letters.length; x > 0; x = Math.floor(x / letters.length)) {
      s += letters[x % letters.length] as string;
      s += "aeiou"[x % 5] as string;
    }
    return s;
  };
  const pick = () => word(Math.floor(o.vocabulary * random() ** 3));
  const words = (k: number) => Array.from({ length: k }, pick).join(" ");
  return Array.from({ length: o.pages }, (_, i) => ({
    node: `https://site.test/p/${String(i).padStart(4, "0")}`,
    fetchId: i + 1,
    url: `https://site.test/p/${i}`,
    title: [`${words(4)} | Example Site`, words(3)],
    links: Array.from({ length: o.anchors }, () => words(1 + Math.floor(random() * 3))),
    body: [`${words(o.bodyWords)}. Share this page with your friends.`],
  }));
}
