# analysis

Python statistics for the LinkLens evaluation experiments (E1–E8) and the corpus batches. This folder is outside the pnpm workspace.

```sh
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux
pip install -e ".[dev]"       # pandas, scipy, matplotlib, pytest
pytest
```

## Experiment results

```sh
python -m linklens_analysis report results/*.json
```

## Corpus batches

```sh
pnpm --filter @linklens/eval corpus run --batch pilot       # audits corpus.yaml (resumable)
pnpm --filter @linklens/eval corpus export --batch pilot    # writes the tidy CSVs
python -m linklens_analysis corpus ../results/corpus/pilot --figures ../results/corpus/pilot/figures
```

E1 (every pair of policies per site, from `policy_pairs.csv`):

```sh
python -m linklens_analysis e1 ../results/corpus/pilot --figures ../results/corpus/pilot/figures
```

It prints the per-class summary (median over sites of each site's mean across the 15 policy pairs, with quartiles and the least-agreeing pair) and writes one policy × policy heatmap per metric, one panel per class plus all sites.

E2 (each discovery channel removed in turn, from `channels.csv`):

```sh
python -m linklens_analysis e2 ../results/corpus/pilot --figures ../results/corpus/pilot/figures
```

It prints, per class and channel, the marginal page yield and the orphans detected only by that channel (pooled share and median site share), then the share of each class's orphans detected only by each channel or by several, and draws that split as a 100% stacked bar chart.

E3 (top-k fixes applied together, LinkLens vs a random admissible donor, the highest-cosine donor and the highest-PageRank donor, from `e3.csv`):

```sh
python -m linklens_analysis e3 ../results/corpus/pilot                     # total ΔPR
python -m linklens_analysis e3 ../results/corpus/pilot --measure relative  # ÷ targets' PR before
```

It prints the paired Wilcoxon signed-rank tests across sites (per k: 10, 25, 50) with the rank-biserial effect size and Holm-corrected p-values, then one table per class.

E4 (each site crawled again 14 days after its first run, from `e4.csv`):

```sh
pnpm --filter @linklens/eval corpus schedule --batch pilot    # prints the daily Task Scheduler / cron line
pnpm --filter @linklens/eval corpus recrawl --batch pilot     # what the schedule runs (only due sites)
pnpm --filter @linklens/eval corpus recrawl --batch pilot --now   # manual trigger
pnpm --filter @linklens/eval corpus export --batch pilot
python -m linklens_analysis e4 ../results/corpus/pilot
```

It prints, per class, the share of pages unchanged, changed, or crawled only once (for a site reason or a crawl reason), and node overlap, PageRank Spearman, orphan Jaccard and top-k fix overlap as observed, with only the site's changes, and on identical pages (the method's own instability).

E5 (Screaming Frog calibration on the 10 marked sites):

```sh
pnpm --filter @linklens/eval corpus import-sf --batch pilot --site vite --from path/to/sf-exports/vite
pnpm --filter @linklens/eval corpus export --batch pilot
python -m linklens_analysis e5 ../results/corpus/pilot
```

It prints the calibration table (per class and policy, P0 and the audit's: URL Jaccard, inlink Spearman, depth agreement, orphan Jaccard) and explains every disagreement category that is large on any site.

E6 (link-masking recovery and the C5 test, from `e6.csv`):

```sh
python -m linklens_analysis e6 ../results/corpus/pilot [--alpha 0.05]
```

It prints each method's MRR, Recall@5/10/20 and AUC per class (mean over sites, bootstrap 95% CI), then the refutation test for C5: the hybrid (REF-gated cosine) against cosine, paired over sites (Wilcoxon signed-rank, one- and two-sided, rank-biserial effect size, Holm over MRR, R@10 and AUC), with a one-line verdict on MRR.

`metrics.csv` has one row per site × policy × metric (`batch_id, site_id, architecture_class, run_id, policy, policy_version, is_audit_policy, metric, value`); `sites.csv` and `stages.csv` describe the sites and the pipeline stages. In Python:

```python
from linklens_analysis import corpus, style

batch = corpus.load_batch("../results/corpus/pilot")
corpus.wide(batch.metrics, "P3")                  # site × metric
corpus.compare_classes(batch.metrics, "P3")       # Kruskal–Wallis per metric, ε², Holm
corpus.policy_effect(batch.metrics, "graph.nodes")  # Friedman across P0–P5

style.apply()                                     # the shared plotting style
corpus.plot_by_class(batch.metrics, "graph.mean_depth")
```

### Plotting style

Every figure uses `linklens_analysis/style.py`: one fixed colour and marker per architecture class (blue ●, orange ■, aqua ▲; the three validate against each other for colour-vision deficiency), a light-to-dark blue ramp for the ordered policies P0–P5, recessive grid and axes, and `style.save()` for PDF (embedded fonts) plus PNG. Take colours from `style`, never pick them per figure; a new class needs the palette re-validated.
