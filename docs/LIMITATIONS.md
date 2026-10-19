# Limitations

What LinkLens's results can and cannot claim. The definitions are in [METHODS.md](METHODS.md),
and the experiments that measure some of these effects are in [EVALUATION.md](EVALUATION.md).

## Prominence is not popularity

The patent LinkLens adapts (Belezko & McGoey, 2023) judges links by **popularity**: how often
visitors actually follow them, from session data. LinkLens has no sessions. It replaces
popularity with **prominence** ω, a structural estimate of how likely a link is to be noticed
and followed, computed from where it sits in the page:

- the region (body 1.0 down to footer 0.1);
- its position among the body links;
- whether its template block is site-wide.

So:

- **ω measures placement, not use.** A prominent link can be ignored and a footer link can be
  well used. Every case that involves ω (v1 misleading, v2 good, v3 buried) is a statement about
  layout, not about reader behaviour.
- **The shape is borrowed, not measured.** The idea that placement predicts use comes from the
  reasonable-surfer model. The specific weights were not fitted to click data.
- **One misclassified region moves ω.** A content block marked up as `<aside>`, or navigation
  without semantic markup, shifts the weights of every link on that page.
- **Only representative pages are weighted.** A template whose signature varies from page to
  page (for instance, because of generated ids) is not recognised as site-wide and is not
  discounted.
- **Where click data exists, prefer it.** Imported analytics replace W, per source page, for
  diagnosis. The counterfactual always uses structural W, so that every graph weight is in one
  unit. The `eval proxy` study measures how well ω tracks real clicks. Until it has been run on a
  site, treat ω as an assumption.

The name is deliberate: code, docs and the dashboard always say "prominence", never
"popularity".

## The 500-page cap

An audit admits at most 500 URLs to its crawl frontier (`maxPageCap`; the API and pipeline refuse
more, even through config overrides). Every admitted URL counts, whatever its outcome: HTML, PDF,
404 or blocked by robots.txt.

- **Large sites are sampled, not audited.** The crawl is breadth-first from the seed, so a
  500-URL crawl of a 50,000-page catalogue sees the shallow part of the site: the home page,
  hubs and the first pages of each category.
- **Deep-page and orphan findings are relative to the sample.** A page beyond the cap is neither
  in the graph nor detectably orphaned by the link graph. Discovery channels (sitemaps, feeds)
  still report it, but reachability is judged on the capped graph, so some "orphans" of a large
  site are simply pages the crawl did not reach. E5 categorises such disagreements as
  `page-cap`.
- **Graph metrics describe the crawled subgraph.** PageRank, betweenness and depth are computed on
  the capped graph. Links that leave it are not followed, so authority that would flow back in
  from deeper pages is missing.
- **Discovery and rescue have their own caps** (100 and 50 requests), so a site with very large
  sitemaps is not fully reconciled either.
- The LSH experiment's 1,000- and 2,000-page research crawls go around the cap on purpose; audits
  do not.

## The weight choices are ours

Several weights and thresholds are judgement calls. They were chosen to be reasonable defaults,
**not fitted to an outcome**. E7 sweeps ε, α and σ to show how sensitive the results are; the
others are not swept.

| Choice                                       | Default                                                                         | Where it matters                         |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| Region weights                               | body 1.0, breadcrumb 0.5, aside 0.4, header/nav 0.3, pagination 0.2, footer 0.1 | ω, hence v1–v3 and make-visible fixes    |
| Position decay, site-wide share and discount | 0.1; 50%; 0.3                                                                   | ω                                        |
| REF cutoff ε                                 | 0.2                                                                             | which pairs are related at all; σ_hybrid |
| Diagnosis threshold α                        | 0.1, for both ρ and ω                                                           | the v1–v4 boundaries                     |
| σ blend λ                                    | 0.5                                                                             | the `blended` σ variant only             |
| Added link weight                            | 1.0 (a body link)                                                               | ΔPR of every simulated fix               |
| κ                                            | distinct body template blocks                                                   | the effort penalty in S                  |
| Boilerplate quota                            | top 7% of n-grams, in at least half the pages                                   | which words count for REF                |
| Page-type priors and importance weights      | 0.4 / 0.25 / 0.2 / 0.15                                                         | S_imp and explanations                   |
| Audit thresholds                             | deep > 3 (high > 6); weak < 20th percentile (high < 5th)                        | which pages become fix targets           |

In particular:

- **S multiplies three quantities of different kinds** (a PageRank gain, a similarity and an
  effort count). Its ranking is meaningful within a site, but its absolute value is not
  comparable across sites.
- **κ is structural.** It counts template blocks, not the real work of editing. A link directly
  under `<body>` has no ancestor chain, so unrelated pages share one signature and template reach
  overcounts.
- **The deep-page and weak-authority cut-offs define the targets.** A site with a different notion
  of depth (a flat documentation site, a deep catalogue) may need other thresholds. Any per-run
  change is stored with the run.

## English-only text processing

The text layer is built for English:

- **Stemming** uses the Porter stemmer, which is English-only. For other languages it conflates
  unrelated words, or fails to merge inflections. Either way, REF counts wrong matches or misses
  real ones.
- **Stop-words** come from the English list (`stopword` eng). A French or German page keeps its
  function words, which then dominate the n-grams until the boilerplate quota removes the most
  frequent ones.
- **Embeddings** use MiniLM (`all-MiniLM-L6-v2`), trained mostly on English. Cosine similarity
  between non-English pages is less reliable, and so is σ.
- **Tokenising** splits on punctuation and whitespace. Languages written without spaces (Chinese,
  Japanese, Thai) are not segmented into words at all.
- **Explanations and anchors** quote n-grams in their written form. The matching behind them
  inherits every issue above.

A page's `lang` attribute is stored but not yet used to choose a stemmer, stop-word list or
model. Multilingual sites mix languages in one site-wide model, so their IDF and boilerplate
statistics are distorted too.

## Other limitations

- **No JavaScript.** Pages are parsed as served (Cheerio/parse5). Links that exist only after
  scripts run, in single-page apps or infinite scroll, are not seen. E5 attributes such
  disagreements to `link-not-extracted`.
- **Politeness bounds coverage.** A host whose robots.txt `Crawl-delay` exceeds 60 s is not
  crawled at all. A robots.txt that is unreachable blocks the whole site, until 30 days of failed
  runs have passed (RFC 9309).
- **One crawl is a snapshot.** Results reflect the site on the crawl date. E4 separates site
  change from method instability over 14 days, but not longer-term drift.
- **Anchor suggestions** consider `<p>` and `<li>` only (not headings or table cells). They match
  already-linked text by exact substring, so an anchor rendered differently (an image `alt`, an
  `aria-label`) is not excluded.
- **ΔPR is a model of authority, not of search rankings.** A higher internal PageRank is a
  plausible, widely used proxy. LinkLens does not claim it changes a search engine's rankings.

## The optional learned layers

These apply only when the importance, learned-prioritiser or GraphSAGE stages run.

- **The labels are masked links, not editorial judgement.** The L13 ranker and GraphSAGE learn
  from hide-and-recover (E6): a candidate is "correct" when it is the page that used to link. This
  rewards the status quo, counts every other good candidate as wrong, and can learn CMS widgets
  that pass the editorial-link filter. A repeated mention or a structural echo can hint at the
  hidden answer. Until E8 ratings exist for at least two sites, report learned results as
  agreement with existing link structure, never as quality.
- **SHAP explains the model, not the site.** TreeSHAP values are exact for the trees, but
  correlated features share credit arbitrarily. The dashboard shows only the top three.
- **Deployable models are in-sample on their training sites.** Audits use a model fit on every
  corpus site. Re-auditing one of them is flagged (`seenSite`), by host only.
- **Small, particular training data.** 28 sites in three architecture classes: other kinds of site
  are out of distribution, without warning. The model parameters are heuristic defaults.
- **GraphSAGE scores are shown, not ranked on.** They are uncalibrated logits, off-scale for sites
  unlike the training sites.
- **A model stage can skip.** A missing model, interpreter or package, or a timeout, skips the
  stage without failing the audit. Check the stage detail before reading an absence of learned
  scores as a result.
