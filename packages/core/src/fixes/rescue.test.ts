import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { buildTextModel, idfOf, type RawDocument } from "../text/model.js";
import type { CounterfactualResult } from "./counterfactual.js";
import {
  externalTargetWeights,
  rankRescue,
  rescueId,
  rescueShortlists,
  type OrphanInput,
} from "./rescue.js";

const S = "https://site.test";
const config = makeConfig({ frequentNgramDropPct: 0 });
const doc = (path: string, title: string, body: string): RawDocument => ({
  node: S + path,
  fetchId: path.length,
  url: S + path,
  title: [title],
  links: [],
  body: [body],
});
// The site: a home page and pages about whales, sharks and cakes; /whales/deep is unreachable.
const model = buildTextModel(
  {
    runId: 1,
    policyVersion: "P0@1.0.0",
    documents: [
      doc("/", "Home", "Welcome. Ocean guides and baking."),
      doc("/whales/guide", "Whale guide", "Blue whale songs. Humpback whale songs."),
      doc("/whales/facts", "Whale facts", "Blue whale size."),
      doc("/whales/deep", "Whale archive", "Blue whale songs archive."),
      doc("/sharks/", "Sharks", "Shark teeth."),
      doc("/login", "Log in", "Blue whale songs members."),
      doc("/baking/cake", "Cake", "Chocolate cake."),
    ],
  },
  config,
);
const depth = new Map([
  [`${S}/`, 0],
  [`${S}/whales/guide`, 2],
  [`${S}/whales/facts`, 1],
  [`${S}/whales/deep`, -1], // unreachable
  [`${S}/sharks/`, 1],
  [`${S}/login`, 1],
  [`${S}/baking/cake`, 1],
]);

const orphan = (
  path: string,
  page: OrphanInput["page"],
  channels: OrphanInput["channels"],
): OrphanInput => ({
  node: S + path,
  urls: [S + path],
  channels,
  sources: { xml_sitemap: [`${S}/sitemap.xml`], feed: [`${S}/feed.xml`] },
  page,
  fetch: { requestedUrl: S + path, statusCode: 200, contentType: "text/html", error: null },
});
const whaleSongs = orphan(
  "/whales/songs",
  { title: ["Whale songs"], body: ["Blue whale songs."] },
  ["xml_sitemap", "feed"],
);
const missing: OrphanInput = {
  ...orphan("/gone", null, ["llms_txt"]),
  fetch: { requestedUrl: `${S}/gone`, statusCode: 404, contentType: "text/html", error: null },
};
const empty = orphan("/blank", { title: [], body: ["The and of."] }, ["html_sitemap"]);

describe("externalTargetWeights", () => {
  it("weights the orphan's Title ∪ Body with the site's IDF, without changing the model", () => {
    const w = externalTargetWeights(
      { title: ["Whale songs"], body: ["Blue whale. Krill."] },
      model,
    );
    expect(w.get("whale")).toBeCloseTo(2 * (model.idf["whale"] as number), 12); // title + body
    expect(w.get("song")).toBeCloseTo(model.idf["song"] as number, 12);
    // A term the site never uses gets the IDF of df = 0.
    expect(w.get("krill")).toBeCloseTo(idfOf(model.stats.documents, 0), 12);
    expect(model.documents).toHaveLength(7);
  });

  it("drops the site's boilerplate terms", () => {
    const withDrop = buildTextModel(
      {
        runId: 1,
        policyVersion: "P0@1.0.0",
        documents: model.documents.map((d) => doc(d.node.replace(S, ""), "Acme", "Acme shop.")),
      },
      makeConfig({ frequentNgramDropPct: 0.5 }),
    );
    expect(withDrop.dropped.map((d) => d.term)).toContain("acm");
    expect(
      externalTargetWeights({ title: ["Acme"], body: ["Acme whales"] }, withDrop).has("acm"),
    ).toBe(false);
  });
});

describe("rescueShortlists (stage 1: REF)", () => {
  const [blank, gone, songs] = rescueShortlists(
    [whaleSongs, missing, empty],
    model,
    depth,
    "weighted",
    config,
  );

  it("shortlists reachable, non-utility donors in allowed sections with REF > ε, by REF", () => {
    expect(songs?.status).toBe("scored");
    expect(songs?.shortlist.map((e) => [e.donor.replace(S, ""), e.refRank])).toEqual([
      ["/whales/guide", 1],
      ["/whales/facts", 2],
    ]);
    const refs = songs?.shortlist.map((e) => e.ref) ?? [];
    expect(refs[0]).toBeGreaterThan(refs[1] as number);
    expect(refs.every((r) => r > config.epsilon)).toBe(true);
  });

  it("counts the donors each rule removed", () => {
    expect(songs?.rejected).toEqual({
      unreachable: 1, // /whales/deep
      utility: 1, // /login
      section: 2, // /sharks/ and /baking/cake: other sections
      "ref-not-above-epsilon": 1, // / (top level, but no whale songs)
      capped: 0,
    });
  });

  it("reports orphans without a page or without scorable text", () => {
    expect(gone).toMatchObject({ status: "no-page", shortlist: [] });
    expect(blank).toMatchObject({ status: "no-text", shortlist: [] });
  });

  it("caps the shortlist at candidateMaxPerTarget", () => {
    const [, , one] = rescueShortlists([whaleSongs, missing, empty], model, depth, "weighted", {
      ...config,
      candidateMaxPerTarget: 1,
    });
    expect(one?.shortlist.map((e) => e.donor)).toEqual([`${S}/whales/guide`]);
    expect(one?.rejected.capped).toBe(1);
  });
});

describe("rankRescue (stage 2: ΔPR)", () => {
  const lists = rescueShortlists([whaleSongs, missing, empty], model, depth, "weighted", config);
  const result = (
    donor: string,
    deltaPr: number,
    depthAfter: number,
  ): [string, CounterfactualResult] => [
    rescueId(S + donor, `${S}/whales/songs`),
    {
      candidateId: rescueId(S + donor, `${S}/whales/songs`),
      donor: S + donor,
      target: `${S}/whales/songs`,
      action: "add-link",
      weightBefore: 0,
      weightAfter: 1,
      prBefore: 0.01,
      prAfter: 0.01 + deltaPr,
      deltaPrTarget: deltaPr,
      deltaPrL1: 2 * deltaPr,
      depthBefore: null,
      depthAfter,
      deltaDepth: null,
      iterations: 10,
      converged: true,
    },
  ];
  // /whales/facts is second by REF but closer to the home page: it passes on more rank.
  const results = new Map([result("/whales/guide", 0.002, 3), result("/whales/facts", 0.005, 2)]);
  const ranked = rankRescue(lists, results, config);
  const songs = ranked.find((o) => o.node === `${S}/whales/songs`);

  it("orders the REF shortlist by ΔPR of the orphan", () => {
    expect(songs?.donors.map((d) => [d.rank, d.donor.replace(S, ""), d.refRank])).toEqual([
      [1, "/whales/facts", 2],
      [2, "/whales/guide", 1],
    ]);
    expect(songs?.donors[0]).toMatchObject({ deltaPr: 0.005, deltaPrL1: 0.01, depthAfter: 2 });
  });

  it("reports the channels that revealed the orphan", () => {
    expect(songs).toMatchObject({
      channels: ["xml_sitemap", "feed"],
      revealedBy: ["xml_sitemap", "feed"],
      status: "scored",
      shortlisted: 2,
    });
    expect(songs?.donors[0]?.reasons[0]).toBe(
      `orphan revealed by xml_sitemap (${S}/sitemap.xml); feed (${S}/feed.xml); no reachable page links to it`,
    );
    expect(songs?.donors[0]?.reasons).toContain("donor is reachable from the home page (depth 1)");
  });

  it("does not count the link graph as revealing an orphan", () => {
    const linked = {
      ...whaleSongs,
      channels: ["link_graph", "llms_txt"] as OrphanInput["channels"],
    };
    const [, , r] = rankRescue(
      rescueShortlists([linked, missing, empty], model, depth, "weighted", config),
      results,
      config,
    );
    expect(r?.revealedBy).toEqual(["llms_txt"]);
  });

  it("keeps the top rescueTopK", () => {
    const top1 = rankRescue(lists, results, { ...config, rescueTopK: 1 });
    expect(top1.find((o) => o.node === `${S}/whales/songs`)?.donors).toHaveLength(1);
  });

  it("refuses a shortlisted donor without a counterfactual result", () => {
    expect(() => rankRescue(lists, new Map(), config)).toThrow(/no counterfactual result/);
  });
});
