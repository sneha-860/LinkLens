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

Every table and figure for RQ1–RQ5, in one command:

```sh
python make_all.py ../results/corpus/pilot          # or: python -m linklens_analysis make-all …
```

It writes `../results/corpus/pilot/results/` (or `--out <dir>`): each table as CSV and LaTeX (booktabs) in `tables/`, each figure as PDF and PNG (plus a `\begin{figure}` snippet) in `figures/`, and a `README.md` that maps every output to its research question and experiment:

| RQ  | Question                                  | Experiments |
| --- | ----------------------------------------- | ----------- |
| RQ0 | The corpus and its architecture classes   | corpus      |
| RQ1 | Canonicalisation sensitivity              | E1          |
| RQ2 | Multi-channel orphan discovery            | E2          |
| RQ3 | Fixes against baselines                   | E3          |
| RQ4 | Re-crawl stability, Screaming Frog        | E4, E5      |
| RQ5 | Semantic layer and σ design (C5)          | E6, E7      |

Outputs whose data is not there yet (no re-crawl, no Screaming Frog import) are skipped and listed with the reason. `manifest.json` records the SHA-256 of every input CSV. The per-experiment commands below print the same tables as Markdown.

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

E7 (the σ / ε / α ablation, from `e7.csv` and `e7_sigma_pairs.csv`):

```sh
python -m linklens_analysis e7 ../results/corpus/pilot --figures ../results/corpus/pilot/figures
```

It prints the σ ablation table (top-k overlap with the default, E3 gain, E6 recovery per σ variant, all sites and each class), the σ variants' pairwise top-k overlap, and the ε and α sweeps as tables, and draws them as sensitivity curves (`e7_epsilon_curves`, `e7_alpha_curves`).

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

### L13 learned prioritiser (`ml/`)

Needs LightGBM: `pip install -e ".[ml]"`. After `pnpm --filter @linklens/eval l13 export --batch <b> --out <dir>`:

```sh
python -m ml train  <dir>/<b>/l13/dataset --out <dir>/<b>/l13/model   # leave-one-site-out, TreeSHAP
pnpm --filter @linklens/eval l13 import --batch <b> --out <dir>        # artefacts + e3.csv
python -m ml report <dir>/<b>/l13/model                                # REPORT.md + figures/shap_summary
```

The model is a LightGBM lambdarank trained on E6 hide-and-recover labels (one hidden donor per query), each site scored by a model that never saw it. The report compares it with S on E6 (MRR, recall@k, AUC; paired Wilcoxon across sites) and E3 (total ΔPR of the top k), and says plainly when it does not beat S.

### Optional GraphSAGE link predictor (`ml/gnn.py`)

Needs PyTorch and PyTorch Geometric. On a CPU-only machine:

```sh
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -e ".[gnn]"
```

Then:

```sh
pnpm --filter @linklens/eval l13 graph-export --batch <b> --out <dir>             # per-site graphs
python -m ml gnn <dir>/<b>/l13/graphs --out <dir>/<b>/l13/gnn --dataset <dir>/<b>/l13/dataset
pnpm --filter @linklens/eval l13 graph-import --batch <b> --out <dir>             # graphsage-scores artefacts
python -m ml train <dir>/<b>/l13/dataset --out <dir>/<b>/l13/model-gs --graphsage <dir>/<b>/l13/gnn
python -m ml gnn-report <dir>/<b>/l13/gnn --ranker <dir>/<b>/l13/model --ranker-graphsage <dir>/<b>/l13/model-gs
```

It is a 2-layer GraphSAGE (mean aggregator) trained leave-one-site-out on the other sites' E6-masked graphs, and it scores E6's own candidates. The report compares it with REF, cosine and the hybrid, gives the runtime, and compares the L13 ranker with and without its score as a feature. It is off by default: set `graphsageEnabled` in the config to add it to E6.

### Plotting style

Every figure uses `linklens_analysis/style.py`: one fixed colour and marker per architecture class (blue ●, orange ■, aqua ▲; the three validate against each other for colour-vision deficiency), a light-to-dark blue ramp for the ordered policies P0–P5, recessive grid and axes, and `style.save()` for PDF (embedded fonts) plus PNG. Take colours from `style`, never pick them per figure; a new class needs the palette re-validated.
