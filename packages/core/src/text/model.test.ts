import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import {
  buildTextModel,
  FIELDS,
  frequentTerms,
  idfOf,
  viewWeights,
  type RawDocument,
  type TextDocument,
  type TextModel,
} from "./model.js";
import { rawDocument } from "./run.js";

const config = makeConfig();
const noDrop = makeConfig({ frequentNgramDropPct: 0 });
const S = "https://site.test";

const doc = (m: TextModel, path: string): TextDocument => {
  const d = m.documents.find((x) => x.node === S + path);
  if (d === undefined) throw new Error(`no document ${path}`);
  return d;
};
const allTerms = (d: TextDocument) => FIELDS.flatMap((f) => Object.keys(d.fields[f]));

// ---------- a 20-page site sharing a title suffix, a share/subscribe block and "Read more" ----------
const TOPICS = [
  "whale",
  "falcon",
  "tiger",
  "otter",
  "panda",
  "koala",
  "zebra",
  "lemur",
  "gecko",
  "bison",
  "camel",
  "heron",
  "moose",
  "llama",
  "hyena",
  "raven",
  "squid",
  "trout",
  "viper",
  "walrus",
];
const PLACES = [
  "glacier",
  "canyon",
  "jungle",
  "river",
  "bamboo",
  "eucalyptus",
  "savanna",
  "madagascar",
  "desert",
  "prairie",
  "sahara",
  "marsh",
  "tundra",
  "andes",
  "steppe",
  "forest",
  "reef",
  "stream",
  "swamp",
  "arctic",
];
const boilerplateSite: RawDocument[] = TOPICS.map((topic, i) => {
  const place = PLACES[i] as string;
  // Page-unique filler so the site has a realistic vocabulary (boilerplate < 7% of it).
  const filler = [..."bcdfghjklmnp"].map((c) => `${topic}${c}o`).join(" ");
  return {
    node: `${S}/${topic}`,
    fetchId: i + 1,
    url: `${S}/${topic}`,
    title: [`${topic} guide | Acme Widgets`, `All about the ${topic}`],
    links: [`Read more on ${topic} diets`],
    body: [
      `The ${topic} lives in the ${place}. ${filler}.`,
      "Share this article on social media. Subscribe to our newsletter.",
    ],
  };
});

describe("site-specific boilerplate removal", () => {
  const m = buildTextModel(
    { runId: 1, policyVersion: "P0@1.0.0", documents: boilerplateSite },
    config,
  );
  const BOILERPLATE = [
    "acm",
    "widget",
    "acm widget",
    "share",
    "articl",
    "social",
    "media",
    "social media",
    "subscrib",
    "newslett",
    "subscrib newslett",
    "guid",
    "read",
    "diet",
  ];

  it("drops n-grams found on every page", () => {
    const dropped = m.dropped.map((d) => d.term);
    for (const t of BOILERPLATE) expect(dropped).toContain(t);
    expect(m.dropped.every((d) => d.df === 20)).toBe(true);
  });

  it("drops at most the quota, and never a term on a single page", () => {
    expect(m.stats.dropped).toBeLessThanOrEqual(
      Math.floor(config.frequentNgramDropPct * m.stats.vocabulary),
    );
    // Only the 20-page terms are eligible (df ≥ frequentNgramMinDf); page-unique terms stay.
    expect(m.stats.dfCutoff).toBe(20);
  });

  it("removes them from every field of every document and from the IDF table", () => {
    for (const d of m.documents) {
      for (const t of BOILERPLATE) {
        expect(allTerms(d)).not.toContain(t);
        expect(d.donor).not.toContain(t);
        expect(d.target).not.toContain(t);
      }
    }
    for (const t of BOILERPLATE) expect(m.idf).not.toHaveProperty(t);
  });

  it("keeps each page's own topic terms", () => {
    const whale = doc(m, "/whale");
    expect(whale.fields.title).toHaveProperty("whale");
    expect(whale.fields.body).toHaveProperty("glacier");
    expect(whale.fields.body).toHaveProperty("whale live");
    expect(whale.fields.links).toHaveProperty("whale diet");
    expect(whale.target).toContain("glacier");
  });

  it("reports the vocabulary and cut-off", () => {
    expect(m.stats.documents).toBe(20);
    expect(m.stats.kept + m.stats.dropped).toBe(m.stats.vocabulary);
    expect(m.stats.dfCutoff).toBe(m.dropped.at(-1)?.df);
    expect(m.version).toBe("text@1.0.0");
    expect(m.policyVersion).toBe("P0@1.0.0");
  });

  it("keeps boilerplate when the drop share is 0", () => {
    const kept = buildTextModel(
      { runId: 1, policyVersion: "P0@1.0.0", documents: boilerplateSite },
      noDrop,
    );
    expect(kept.dropped).toEqual([]);
    expect(doc(kept, "/whale").fields.title).toHaveProperty("acm widget");
  });
});

describe("frequentTerms", () => {
  const df = new Map([
    ["a", 5],
    ["b", 5],
    ["c", 3],
    ["d", 1],
    ["e", 1],
    ["f", 1],
    ["g", 1],
    ["h", 1],
    ["i", 1],
    ["j", 1],
  ]);
  const cf = new Map([
    ["a", 5],
    ["b", 9],
    ["c", 3],
  ]);

  it("takes floor(pct × vocabulary) terms by DF, ties by total count then term", () => {
    expect(frequentTerms(df, cf, 0.25, 2).map((d) => d.term)).toEqual(["b", "a"]);
    expect(frequentTerms(df, cf, 0.3, 2).map((d) => d.term)).toEqual(["b", "a", "c"]);
    expect(frequentTerms(df, new Map(), 0.1, 2).map((d) => d.term)).toEqual(["a"]);
  });

  it("never drops a term in fewer than minDf documents, whatever the quota", () => {
    expect(frequentTerms(df, cf, 1, 2).map((d) => d.term)).toEqual(["b", "a", "c"]);
    expect(frequentTerms(df, cf, 1, 1)).toHaveLength(10);
  });
});

// ---------- field separation ----------
const link = (anchorText: string, domRegion: string, positionIndex: number) => ({
  anchorText,
  domRegion,
  positionIndex,
});
const separationSite: RawDocument[] = [
  rawDocument(
    `${S}/b`,
    {
      fetchId: 2,
      url: `${S}/b`,
      title: "Blue Whale",
      h1: "Facts",
      bodyText: "The blue whale is the largest animal.",
    },
    [
      link("Pricing plans", "main", 0),
      link("Contact sales", "nav", 1),
      link("Careers", "footer", 2),
      link("Next page", "pagination", 3),
      link("Krill diet", "body", 4),
    ],
  ),
  rawDocument(
    `${S}/a`,
    { fetchId: 1, url: `${S}/a`, title: "Ocean guide", h1: null, bodyText: "Tides and currents." },
    [link("Blue whale", "main", 0)],
  ),
];

describe("field separation", () => {
  const m = buildTextModel(
    { runId: 1, policyVersion: "P0@1.0.0", documents: separationSite },
    noDrop,
  );
  const a = doc(m, "/a");
  const b = doc(m, "/b");

  it("Title = title + h1, never bridged into one bigram", () => {
    expect(Object.keys(b.fields.title)).toEqual(["blue", "blue whale", "fact", "whale"]);
  });

  it("Links = anchors of the page's own content-region links only (chrome excluded)", () => {
    expect(Object.keys(b.fields.links).sort()).toEqual(
      ["diet", "krill", "krill diet", "plan", "price", "price plan"].sort(),
    );
    for (const t of ["contact", "sale", "career", "page", "next"]) {
      expect(allTerms(b)).not.toContain(t);
    }
  });

  it("Body holds only the body text", () => {
    expect(Object.keys(b.fields.body)).toEqual(
      ["anim", "blue", "blue whale", "largest", "largest anim", "whale", "whale largest"].sort(),
    );
    expect(b.fields.body).not.toHaveProperty("fact");
    expect(b.fields.body).not.toHaveProperty("price");
  });

  it("incoming anchors never reach the target page", () => {
    expect(a.fields.links).toHaveProperty("blue whale");
    expect(allTerms(b)).not.toContain("ocean");
    expect(b.fields.links).not.toHaveProperty("blue whale");
  });

  it("S_A (donor) = Links ∪ Body: includes the page's anchors, excludes title-only terms", () => {
    expect(b.donor).toContain("price plan");
    expect(b.donor).toContain("largest anim");
    expect(b.donor).not.toContain("fact");
  });

  it("S_B (target) = Title ∪ Body: excludes the page's own outgoing anchors", () => {
    expect(b.target).toContain("fact");
    expect(b.target).toContain("largest anim");
    for (const t of ["price", "plan", "price plan", "krill", "diet"])
      expect(b.target).not.toContain(t);
    expect(a.target).not.toContain("whale");
    expect(a.donor).toContain("whale");
  });

  it("views are sorted and exactly the union of their fields", () => {
    const union = (fs: (keyof TextDocument["fields"])[]) =>
      [...new Set(fs.flatMap((f) => Object.keys(b.fields[f])))].sort();
    expect(b.donor).toEqual(union(["links", "body"]));
    expect(b.target).toEqual(union(["title", "body"]));
  });
});

describe("TF-IDF", () => {
  const m = buildTextModel(
    { runId: 1, policyVersion: "P0@1.0.0", documents: separationSite },
    noDrop,
  );
  const b = doc(m, "/b");

  it("uses smoothed IDF ln((1+N)/(1+df)) + 1 and raw counts per field", () => {
    expect(idfOf(2, 2)).toBe(1);
    // "blue whale" is on both pages (A's anchor, B's title/body); "fact" only on B.
    expect(m.idf["blue whale"]).toBeCloseTo(1);
    expect(m.idf["fact"]).toBeCloseTo(Math.log(3 / 2) + 1);
    expect(b.fields.title["fact"]).toBeCloseTo(Math.log(3 / 2) + 1);
    const repeat = buildTextModel(
      {
        runId: 1,
        policyVersion: "P0@1.0.0",
        documents: [
          {
            node: `${S}/x`,
            fetchId: 1,
            url: `${S}/x`,
            title: [],
            links: [],
            body: ["whale. whale. whale"],
          },
        ],
      },
      noDrop,
    );
    expect(repeat.documents[0]?.fields.body["whale"]).toBeCloseTo(3 * idfOf(1, 1));
  });

  it("view weights sum the fields' weights", () => {
    const donor = viewWeights(b, "donor");
    const target = viewWeights(b, "target");
    expect(donor.get("price")).toBeCloseTo(b.fields.links["price"] as number);
    expect(target.get("blue")).toBeCloseTo(
      (b.fields.title["blue"] as number) + (b.fields.body["blue"] as number),
    );
    expect([...donor.keys()].sort()).toEqual(b.donor);
    expect([...target.keys()].sort()).toEqual(b.target);
  });
});

describe("determinism and edge cases", () => {
  it("does not depend on document order", () => {
    const one = buildTextModel(
      { runId: 1, policyVersion: "P0@1.0.0", documents: boilerplateSite },
      config,
    );
    const two = buildTextModel(
      { runId: 1, policyVersion: "P0@1.0.0", documents: [...boilerplateSite].reverse() },
      config,
    );
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.documents.map((d) => d.node)).toEqual([...one.documents.map((d) => d.node)].sort());
  });

  it("keeps empty documents and handles an empty site", () => {
    const empty = { node: `${S}/e`, fetchId: 1, url: `${S}/e`, title: [], links: [], body: [] };
    const m = buildTextModel({ runId: 1, policyVersion: "P0@1.0.0", documents: [empty] }, config);
    expect(m.documents[0]).toMatchObject({
      donor: [],
      target: [],
      fields: { title: {}, links: {}, body: {} },
    });
    expect(
      buildTextModel({ runId: 1, policyVersion: "P0@1.0.0", documents: [] }, config).stats,
    ).toEqual({
      documents: 0,
      vocabulary: 0,
      dropped: 0,
      kept: 0,
      dfCutoff: null,
    });
  });

  it("rejects two documents for one node", () => {
    const d = boilerplateSite[0] as RawDocument;
    expect(() =>
      buildTextModel({ runId: 1, policyVersion: "P0@1.0.0", documents: [d, d] }, config),
    ).toThrow(/duplicate/);
  });

  it("rawDocument skips missing title/h1/body and null anchors, in document order", () => {
    const r = rawDocument(
      `${S}/p`,
      { fetchId: 1, url: `${S}/p`, title: null, h1: "", bodyText: null },
      [
        { anchorText: "second", domRegion: "main", positionIndex: 2 },
        { anchorText: null, domRegion: "main", positionIndex: 1 },
        { anchorText: "first", domRegion: "body", positionIndex: 0 },
        { anchorText: "unknown", domRegion: null, positionIndex: 3 },
      ],
    );
    expect(r).toMatchObject({ title: [], body: [], links: ["first", "second"] });
  });
});
