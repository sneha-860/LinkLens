# Evaluation

The protocols of experiments E1–E8: what each asks, what it runs on, how it is measured and how
it is tested. The definitions it relies on (policies, REF, ρ, ω, σ, S, κ) are in
[METHODS.md](METHODS.md).

| ID  | Experiment                   | Research question                                                                    |
| --- | ---------------------------- | ------------------------------------------------------------------------------------ |
| E1  | Canonicalisation sensitivity | RQ1: how much do the audit's conclusions depend on URL policy?                       |
| E2  | Channel ablation             | RQ2: what does each discovery channel add to orphan detection?                       |
| E3  | Fixes vs baselines           | RQ3: do LinkLens's fixes raise weak pages' PageRank more than simpler rules?         |
| E4  | 14-day re-crawl stability    | RQ4: are the results stable, and is change the site's or the method's?               |
| E5  | Screaming Frog calibration   | RQ4: does the crawl agree with an established crawler, and why not where it doesn't? |
| E6  | Hide-and-recover             | RQ5: can the semantic layer recover links hidden from a site?                        |
| E7  | σ / ε / α ablation           | RQ5: which relatedness measure and thresholds work best (claim C5)?                  |
| E8  | Human rating (optional)      | are the top fixes relevant and well placed, according to people?                     |

## Common setup

- **Corpus.** `packages/eval/corpus.yaml` lists 28 public sites in three architecture classes:
  `cms-blog`, `ecommerce-catalogue` and `documentation`. There is one seed, one audit policy
  (P3), σ (`refGateCosine`) and REF variant (`weighted`), and no config overrides by default.
- **Running the corpus.** `corpus run --batch <name>` audits the sites one at a time, through the
  same 21-stage pipeline as the API. With `rankAllPolicies`, it also ranks fixes under all six
  policies for E1. The batch is resumable. Its manifest is the reproducibility record, and a
  resume is refused if anything the results depend on has changed:
  - the git commit and the hash of any uncommitted diff;
  - the config hash, the seed and the User-Agent;
  - every stage and policy version;
  - the embedding model's and scoring models' file hashes;
  - the lockfile hash.
- **Politeness.** Every crawl obeys robots.txt (RFC 9309) and the per-host delay:
  max(500 ms, the site's Crawl-delay). Each crawl admits at most 500 URLs.
- **Determinism.** All sampling uses `randomSeed` (42), or a documented offset of it such as
  seed + r for repeat r.
- **Unit of analysis.** A **site**. Per-site values are summarised per class and over all sites.
  Tests are paired across sites and non-parametric:
  - Wilcoxon signed-rank, with zero differences dropped;
  - effect size as matched-pairs rank-biserial r = (R⁺ − R⁻)/(R⁺ + R⁻);
  - Holm correction within each family;
  - seeded bootstrap 95% confidence intervals.

  With n sites, the smallest possible two-sided p in a class is 2/2ⁿ before correction.

- **Outputs.** `corpus export` writes tidy CSVs (`csv.ts` is the column contract).
  `python analysis/make_all.py <batch>` turns them into `tables/` (CSV and LaTeX), `figures/`
  (PDF and PNG) and a README that maps every output to its RQ. An output whose data is missing is
  skipped with a stated reason, never faked.

## E1: Canonicalisation sensitivity

**Question.** Do URL-merging choices change the graph, the orphans, the metrics and the
recommended fixes?

**Protocol.**

1. Derive each audited run under all six policies P0–P5 in memory, from the same raw
   observations. No new crawl is needed, since raw data is never normalised.
2. Compare every unordered pair of policies: 15 pairs, a before b, signed values b − a.
3. Pages are matched in P3 form. A P3 page's PageRank is the sum of its merged nodes', and its
   depth is the smallest of theirs.

**Measures, per pair.**

- node counts: b − a and b/a;
- the shared P3 pages and their Jaccard;
- the Jaccard of the orphan sets;
- the Spearman correlation of PageRank over shared pages;
- the depth shift over pages reachable under both (mean, mean |·| and max |·|);
- the Jaccard of the top-k fixes, as (donor, target) pairs, when both policies were ranked.

**Analysis.** Per class, the median over sites of each site's mean across pairs, with quartiles,
and the least-agreeing pair. An agreement matrix, policy × policy, is drawn as a heatmap per class.
Across policies, the Friedman test.

## E2: Channel ablation

**Question.** What does each discovery channel contribute, beyond the others, to the page
inventory and to finding orphans?

**Protocol.**

- Every subset of the five non-link channels: orphans found, recall and pages known.
- Each channel alone.
- Leave-one-out loss: each of the six channels removed in turn, and the reconciliation recomputed
  from the remaining observations.

**Measures, per channel.**

- pages found, and pages lost without it (its marginal page yield);
- orphans it detects, and orphans lost without it (detected only by it), with their share of all
  orphans;
- orphans split into those revealed by exactly one non-link channel and those revealed by several.

**Checks.** Removing a channel never creates an orphan, and removing the link graph loses pages
but never an orphan. Both are asserted in code.

**Analysis.** Per class, marginal pages and exclusive orphans (pooled, and as the median site
share), shown as 100% stacked bars of each class's orphans by revealing channel.

## E3: Fixes vs baselines

**Question.** If a site editor applied the top k recommendations, would the pages that need
authority gain more than with simpler rules?

**Protocol.**

1. **Targets T:** the audit's weak-authority pages (below the 20th PageRank percentile) and the
   reconciled orphans.
2. **Pool:** the fix candidates of the weak-authority targets and each orphan's rescue
   shortlist. Everything is on orphan rescue's graph: structural prominence W, plus the orphan
   nodes.
3. Simulate each pool entry alone for its ΔPR. Cosine comes from an embedder with the run's model.
4. Each method picks a global top k from the pool:
   - `linklens`: S = ΔPR × σ / κ with the run's σ;
   - `random`: the mean of 20 seeded draws (seed + k);
   - `highestCosine`: ignores the graph gain;
   - `highestPagerank`: the donor's PageRank; ignores semantics.
5. Apply each method's k links **together** to one copy of the graph, with PageRank recomputed
   warm-started. Joint effects are not additive, so this is not a sum of the single ΔPRs.

**Primary measure.** Total ΔPR over T for k ∈ {10, 25, 50}. The `relative` variant divides by
the targets' PageRank before, so sites of different sizes are comparable.

**Secondary measures.** Fixes selected, targets covered, the sum of single ΔPRs, the site-wide
L1 change, newly reachable targets, and the mean REF and cosine of the chosen links.

**Analysis.** For each k, LinkLens against each baseline across sites: Wilcoxon signed-rank
(two-sided), r, wins/ties/losses and the median difference, with Holm over the three baselines.

## E4: 14-day re-crawl stability

**Question.** When a site is audited again, how much do the results change, and is that because
the site changed or because the method is unstable?

**Protocol.**

1. Re-crawl every completed site 14 days after its first run (`corpus recrawl`, a second wave
   with an identical config, versions and models).
2. Classify each page:
   - **crawled in both:** `unchanged` or `changed`, by a signature over title, h1, body, meta
     robots, canonical, nofollow and every out-link (with anchor, region and rel) in order;
   - **crawled once, for a site reason:** gone (4xx), redirected elsewhere, not HTML, blocked by
     robots.txt or Crawl-delay, or no longer linked;
   - **crawled once, for a crawl reason:** linked but not admitted (cap or order), or failed
     (5xx, network, timeout, robots.txt unreachable).
3. Compare the audits four ways, with the restricted ones re-run in memory. Unrestricted, the
   in-memory run reproduces the stored ranking; this is tested.
   - **observed:** the two runs as they are;
   - **site change:** each run restricted to the pages both crawled, plus its site-caused ones;
   - **same pages:** both restricted to the unchanged pages and documents. The inputs are then
     identical, so any remaining difference is the method's;
   - **coverage:** each run with and without the pages the other missed for crawl reasons.

**Measures.** Node overlap, PageRank Spearman, orphan Jaccard and top-k fix Jaccard, in each
comparison.

**Analysis.** Per class, median disagreement (1 − agreement) in each comparison, and the site's
share of the observed disagreement.

## E5: Screaming Frog calibration

**Question.** Does LinkLens's crawl agree with an established commercial crawler, and can every
disagreement be explained?

**Protocol.**

1. Crawl 9 corpus sites (4 blogs, 3 catalogues, 2 documentation sites) with Screaming Frog from
   the same seed. pytest, planned as a tenth, blocks crawlers.
2. Import its exports with `corpus import-sf`: Internal: All, All Inlinks and Orphan Pages. Each
   file is parsed and hashed. When Screaming Frog did not look for orphans (the free version
   crawls no sitemaps), the report is skipped with `--no-orphans` and recorded as such: an empty
   report would read as "no orphans found", so the orphan comparison is left out instead.
3. Map both tools' URLs through P0 and through the audit's policy, using the run's own redirect
   and canonical context, and compare:
   - **URL sets:** HTML 200 pages, Jaccard;
   - **inlinks:** Spearman against distinct sources recomputed from All Inlinks under the same
     policy, and against Screaming Frog's Unique Inlinks column;
   - **crawl depth:** exact match, within ±1, Spearman, mean |Δ|, and whether the seeds differ;
   - **orphans:** Screaming Frog's orphan report against the reconciled orphans.
4. Give every disagreement one category by ordered rules, with evidence and a one-sentence
   explanation. For example:
   - normalisation (the URLs meet under a coarser policy);
   - robots.txt;
   - status code;
   - page cap;
   - a link type LinkLens does not extract (JavaScript, canonical…);
   - nofollow;
   - a redirect hop;
   - a parent page not crawled;
   - a cascade of an earlier difference.

   An inlink gap counts only when it is at least 2 and at least 50% of the larger count.

**Analysis.** Per class and policy, the median [quartiles] of each agreement measure. The
disagreement categories that are **large** on any site (at least 10% of their kind and at least
3 cases) are listed with their pooled count and share, example sites and explanation.

## E6: Hide-and-recover

**Question.** If an editorial link is hidden, can the semantic layer find the page that used to
carry it?

**Protocol.**

1. **Editorial links:** body-region observations between two pages with text, whose template
   block is not site-wide.
2. **Masking.** Each of 5 repeats (seed + r) masks a share drawn uniformly from 10–20% of those
   pairs. For every masked pair:
   - all its observations leave the graph;
   - its anchor text leaves the donor's Links field;
   - its first occurrence leaves the donor's body text, since body text contains link text and
     would otherwise leak the answer.
3. Rebuild the text model, REF and the embeddings from the masked site.
4. **Queries:** each masked link u*→v. Its candidates are every page with text except v, pages
   still linking to v, and v's other masked donors.
5. **Methods:** `ref`, `cosine`, `jaccard` (donor view vs target view terms), `refGateCosine`
   (σ_hybrid), `blended` and `random`. With `e6GraphBaselines`, add `commonNeighbours` and
   `adamicAdar` (undirected, on the masked graph). Optionally add `graphsage`, from a
   leave-one-site-out model.

**Measures.** Recall@k (k ∈ {5, 10, 20}), MRR and AUC of the hidden donor's rank. Each is the
**expectation over random tie-breaking**, so the random baseline is exactly k/N, H_N/N and ½.

**Analysis.** A site's value is its mean over repeats. Per class, a table of method × measure with
bootstrap CIs. **Test of claim C5:**

- σ_hybrid vs cosine across sites, Wilcoxon signed-rank, one-sided (hybrid > cosine) and
  two-sided, with r;
- Holm over MRR (primary), R@10 and AUC;
- verdict: _supported_ (one-sided p < α on MRR after Holm), _refuted_ (cosine significantly
  better) or _not supported_.

E6 also supplies the labels of the optional learned prioritiser (METHODS.md §10).

## E7: σ / ε / α ablation

**Question.** Which σ variant, REF cutoff ε and diagnosis threshold α give the best fixes, and
how sensitive are the rankings to them?

**Protocol.**

- **Settings:**
  - each σ variant at the default ε (0.2) and α (0.1);
  - each σ along ε ∈ {0.05, 0.10, …, 0.40} at the default α;
  - each σ along α ∈ {0.05, …, 0.30} at the default ε.

  Each setting runs once.

- **Re-computed per setting.** REF, diagnosis, candidates and counterfactual per (ε, α), cached;
  scoring per σ. The graph, audit, text, prominence and κ are computed once.
- **Scoring sweep.** Each σ at the defaults, also under S_imp (S × target importance).

**Measures, per setting.**

- the top-k Jaccard with the default setting's ranking;
- E3: LinkLens's top-k applied together, and the random baseline, for each k;
- E6 recovery for the σ. One masking run is shared, with the hybrid also gated at each ε; α does
  not enter E6.

Also the pairwise top-k Jaccard between σ variants at the defaults. At the default setting, E3
and E6 agree with the experiments run alone (tested).

**Analysis.** Per σ, the mean over sites [bootstrap 95% CI] of top-k overlap, E3 gain over random
and E6 MRR, R@10 and AUC. Curves across the ε and α sweeps, and σ-pair Wilcoxon tests.

## E8: Human rating (optional)

**Question.** Do people judge the top-ranked fixes relevant, and the suggested placement good?

**Protocol.**

1. Draw a blind sample, once per audit: 50 fixes from the top 50 of the latest ranking for the
   audit's σ, in a seeded random order.
2. Show each item without its score, rank, ΔPR, REF, σ or explanation. The rater sees the donor
   and target pages (titles and links), the action, and the suggested paragraph with the anchor
   marked.
3. Two raters, slots A and B, answer independently on the dashboard's rating tab:
   - **relevant:** yes or no;
   - **placement:** good, acceptable or poor, or n/a if not relevant or nothing was suggested.

   Answers are append-only, and the latest per (sample, rater, item) counts.

4. The results are folded away until opened, so they do not bias the raters.

**Measures.**

- per rater: precision@k (k ∈ {5, 10, 25, 50}) over rated items with rank ≤ k, and placement
  counts;
- consensus: strict (relevant to both, over items both rated) and the mean of the two raters'
  precision;
- agreement: relevance observed agreement and Cohen's κ;
- placement agreement and linear-weighted κ, over items both marked relevant.

The CLI variant writes a rating sheet (CSV) and summarises filled sheets: mean relevance,
would-add rate, top 10 vs the rest, and the score–relevance Spearman.

E8 is not part of a corpus export. Where at least two sites have ratings, they also serve as a
second label set for the learned prioritiser.

## Supplementary studies

- **Proxy validation (`eval proxy`).** Does structural prominence track real clicks?
  - **Link level (analytics CSV):** ω against click shares, as a pooled Spearman, the mean
    within-source Spearman and hit@1.
  - **Page level (Search Console):** inbound prominence against clicks.
  - Both are compared with link-count baselines, with seeded bootstrap CIs and paired differences.
- **LSH pre-filter (`eval lsh`).** Candidate recall, REF-mass recall, top-donor recall and runtime
  of the LSH Ensemble pre-filter against the exact REF, at caps of 500, 1,000 and 2,000 pages.
  These research crawls go straight through the orchestrator, so they are not held to the
  500-page audit cap.
- **Learned prioritiser and GraphSAGE.** Leave-one-site-out on E6 labels, compared with S and
  σ_hybrid on E6 and E3 (METHODS.md §10).

## Running

```sh
pnpm --filter @linklens/eval corpus run --batch b1            # audit every corpus site (resumable)
pnpm --filter @linklens/eval corpus recrawl --batch b1        # E4 wave, 14 days later (daily)
pnpm --filter @linklens/eval corpus import-sf --batch b1 --site <id> --from <folder>   # E5
pnpm --filter @linklens/eval corpus export --batch b1         # tidy CSVs for E1–E7
python analysis/make_all.py results/corpus/b1                 # tables, figures, README
pnpm --filter @linklens/eval e E3 --run 12 --out results/e3.json   # one experiment, one run
```
