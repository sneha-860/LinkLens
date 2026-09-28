"""Regenerate every table (LaTeX + CSV) and figure (PDF + PNG) for RQ1–RQ5 from a corpus batch
export, with a README that maps each one to its research question and experiment.

    python make_all.py <batch dir> [--out <dir>] [--k 10] [--alpha 0.05]

The RQ → experiment mapping is RQS below; each output is one entry of ARTIFACTS. An output whose
data is not in the export yet (no re-crawl, no Screaming Frog import, …) is skipped with the
reason, and the README says so; nothing else is affected. Everything but manifest.json (which
records when it ran and the inputs' SHA-256) is byte-identical for the same export.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from . import corpus, e1, e2, e3, e4, e5, e6, e7, style
from .latex import escape, flat, to_latex


@dataclass(frozen=True)
class ResearchQuestion:
    id: str
    title: str
    question: str
    experiments: tuple[str, ...]


RQS: list[ResearchQuestion] = [
    ResearchQuestion(
        "RQ0",
        "Corpus",
        "What does the corpus look like, and how do the architecture classes differ structurally?",
        ("corpus",),
    ),
    ResearchQuestion(
        "RQ1",
        "Canonicalisation sensitivity",
        "How much do the audit's results depend on the URL canonicalisation policy (P0–P5)?",
        ("E1",),
    ),
    ResearchQuestion(
        "RQ2",
        "Multi-channel orphan discovery",
        "What does each discovery channel add to finding orphan pages?",
        ("E2",),
    ),
    ResearchQuestion(
        "RQ3",
        "Fixes against baselines",
        "Do LinkLens's top-k fixes raise the link equity of weak and orphan pages more than simple baselines?",
        ("E3",),
    ),
    ResearchQuestion(
        "RQ4",
        "Validity and stability",
        "Is the audit stable across re-crawls, and does it agree with an established crawler?",
        ("E4", "E5"),
    ),
    ResearchQuestion(
        "RQ5",
        "Semantic layer and σ design (C5)",
        "Does the REF-gated hybrid σ recover real editorial links better than cosine alone, and how sensitive are the results to σ, ε and α?",
        ("E6", "E7"),
    ),
]


class Skip(Exception):
    """The artefact's data is not in the export (the message says why)."""


@dataclass(frozen=True)
class Options:
    k: int = 10
    alpha: float = 0.05


# A table builder returns the table (or (LaTeX table, CSV table) when the CSV should carry the
# numbers behind a formatted table); a figure builder returns a matplotlib figure.
Builder = Callable[[corpus.Batch, Options], object]


@dataclass(frozen=True)
class Artifact:
    id: str
    rq: str
    experiment: str
    kind: str  # "table" | "figure"
    title: str
    caption: str
    build: Builder = field(repr=False)


def _need(df: pd.DataFrame, what: str, how: str) -> None:
    if df.empty:
        raise Skip(f"no {what} in the export ({how})")


def _audit_policy(b: corpus.Batch) -> str:
    policies = b.sites["audit_policy"].dropna().unique()
    return str(policies[0]) if len(policies) else "P3"


# ---------- builders ----------


def corpus_sites(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.sites, "sites", "corpus export")
    s = b.sites.copy()
    classes = style.ordered_classes(list(s["architecture_class"].unique()))
    rows = []
    for cls in [*classes, "all sites"]:
        g = s if cls == "all sites" else s[s["architecture_class"] == cls]
        rows.append(
            {
                "class": "All sites" if cls == "all sites" else style.class_label(cls),
                "sites": len(g),
                "completed": int((g["status"] == "completed").sum()),
                "failed": int((g["status"] == "failed").sum()),
                "median pages crawled": float(g["pages_fetched"].median()) if g["pages_fetched"].notna().any() else np.nan,
                "median duration (min)": float(g["duration_s"].median() / 60) if g["duration_s"].notna().any() else np.nan,
            }
        )
    return pd.DataFrame(rows).set_index("class")


def corpus_classes(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.metrics, "metrics", "corpus export")
    present = set(b.metrics["metric"])
    return corpus.compare_classes(b.metrics, _audit_policy(b), [m for m in corpus.DEFAULT_METRICS if m in present])


def e1_summary(b: corpus.Batch, o: Options):
    _need(b.pairs, "policy pairs (E1)", "corpus export")
    s = e1.class_summary(b.pairs)
    return e1.summary_wide(s), s


def e1_least(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.pairs, "policy pairs (E1)", "corpus export")
    s = e1.class_summary(b.pairs)[["worst_pair", "worst_value"]].reset_index()
    s["metric"] = s["metric"].map(lambda m: e1.BY_NAME[m].label if m in e1.BY_NAME else m)
    return s.set_index(["architecture_class", "metric"])


def e1_heatmap(metric: str) -> Builder:
    def build(b: corpus.Batch, o: Options):
        _need(b.pairs, "policy pairs (E1)", "corpus export")
        if metric not in set(e1.pairs_long(b.pairs)["metric"]):
            raise Skip(f"no {metric} in policy_pairs.csv (e.g. no fix ranking under every policy)")
        return e1.agreement_figure(b.pairs, metric)

    return build


def e2_channels(b: corpus.Batch, o: Options):
    _need(b.channels, "channel removals (E2)", "corpus export")
    t = e2.class_table(b.channels)
    return e2.display_table(t), t


def e2_composition(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.channels, "channel removals (E2)", "corpus export")
    comp = e2.composition(b.channels)
    shares = e2.composition_shares(comp)
    shares.columns = [style.CHANNEL_LABELS.get(c, "Several channels") for c in shares.columns]
    shares.insert(0, "orphans", comp["orphans"].astype(int))
    return shares


def e2_figure(b: corpus.Batch, o: Options):
    _need(b.channels, "channel removals (E2)", "corpus export")
    return e2.plot_composition(b.channels).figure


def _e3_labels(t: pd.DataFrame) -> pd.DataFrame:
    return t.rename(index=e3.METHOD_LABELS, level="baseline")


def e3_paired(measure: str) -> Builder:
    def build(b: corpus.Batch, o: Options) -> pd.DataFrame:
        _need(b.e3, "E3 results", "corpus export with the embedding model")
        return _e3_labels(e3.paired_tests(b.e3, measure))

    return build


def e3_by_class(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e3, "E3 results", "corpus export with the embedding model")
    tables = e3.class_tables(b.e3)
    return pd.concat(
        {("All sites" if c == e3.ALL else style.class_label(c)): t for c, t in tables.items()},
        names=["class"],
    )


def e3_figure(b: corpus.Batch, o: Options):
    _need(b.e3, "E3 results", "corpus export with the embedding model")
    return e3.paired_figure(b.e3, "relative")


_RECRAWL = "run `corpus recrawl` (14 days after the first run), then `corpus export`"
_SF = "import the Screaming Frog exports with `corpus import-sf`, then `corpus export`"


def e4_summary(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e4, "re-crawl comparisons (E4)", _RECRAWL)
    return e4.summary_table(b.e4)


def e4_attribution(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e4, "re-crawl comparisons (E4)", _RECRAWL)
    return e4.attribution(b.e4)


def e4_figure(b: corpus.Batch, o: Options):
    _need(b.e4, "re-crawl comparisons (E4)", _RECRAWL)
    return e4.attribution_figure(b.e4)


def e5_calibration(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e5, "Screaming Frog calibrations (E5)", _SF)
    return e5.calibration_table(b.e5)


def e5_large(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e5_categories, "Screaming Frog disagreement categories (E5)", _SF)
    large = e5.large_categories(b.e5_categories)
    if large.empty:
        raise Skip("no disagreement category is large on any site")
    return large


_E6 = "corpus export with the embedding model"


def e6_results(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e6, "E6 results", _E6)
    return e6.results_table(b.e6)


def e6_c5(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e6, "E6 results", _E6)
    return e6.paired_test(b.e6)


def e6_c5_by_class(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e6, "E6 results", _E6)
    classes = style.ordered_classes(list(b.e6["architecture_class"].unique()))
    return pd.concat(
        {style.class_label(c): e6.paired_test(b.e6, scope=c) for c in classes}, names=["class"]
    )


def e6_figure(b: corpus.Batch, o: Options):
    _need(b.e6, "E6 results", _E6)
    return e6.methods_figure(b.e6, "mrr")


def e7_ablation(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e7, "E7 results", _E6)
    tables = {"All sites": e7.ablation_table(b.e7, o.k)}
    for c in style.ordered_classes(list(b.e7["architecture_class"].unique())):
        tables[style.class_label(c)] = e7.ablation_table(b.e7, o.k, scope=c)
    return pd.concat(tables, names=["class"])


def e7_pairs(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e7_pairs, "E7 σ pairs", _E6)
    return e7.sigma_pair_matrix(b.e7_pairs)


def e7_scoring(b: corpus.Batch, o: Options) -> pd.DataFrame:
    _need(b.e7, "E7 ablations", _E6)
    t = e7.scoring_table(b.e7, o.k)
    if t.empty:
        raise Skip("no S_imp rows in e7.csv (exported before the scoring sweep)")
    return t


def e7_curves(sweep: str) -> Builder:
    def build(b: corpus.Batch, o: Options):
        _need(b.e7, "E7 results", _E6)
        metrics = ["topk_jaccard_default", f"e3_gain@{o.k}"] + (["e6_mrr"] if sweep == "epsilon" else [])
        return e7.curves_figure(b.e7, sweep, metrics)

    return build


# ---------- the registry ----------

ARTIFACTS: list[Artifact] = [
    Artifact("t0_corpus_sites", "RQ0", "corpus", "table", "The corpus",
             "Sites per architecture class: how many completed or failed, the median number of pages crawled and the median audit duration.",
             corpus_sites),
    Artifact("t0_corpus_classes", "RQ0", "corpus", "table", "Architecture classes compared",
             "Structural metrics under the audit's policy compared across the three classes: Kruskal–Wallis H, p, ε² (rank effect size) and Holm-corrected p.",
             corpus_classes),
    Artifact("t1_e1_summary", "RQ1", "E1", "table", "Agreement between canonicalisation policies",
             "Per class: the median over sites of each site's mean across the 15 pairs of policies P0–P5 [quartiles], for node-count ratio, orphan Jaccard, PageRank Spearman, mean and max depth shift, and top-k fix Jaccard.",
             e1_summary),
    Artifact("t1_e1_least_agreeing", "RQ1", "E1", "table", "Least-agreeing pair of policies",
             "Per class and metric: the pair of policies whose median over sites agrees least.",
             e1_least),
    *[
        Artifact(f"f1_e1_{m.name}", "RQ1", "E1", "figure", f"Policy × policy: {m.label}",
                 f"{m.label} between every pair of policies (lower triangle; cell (row, column) is the pair (column, row)), median over sites, one panel per class and one for all sites.",
                 e1_heatmap(m.name))
        for m in e1.METRICS
    ],
    Artifact("t2_e2_channels", "RQ2", "E2", "table", "Marginal yield of each discovery channel",
             "Each channel removed in turn: inventory pages lost (marginal page yield) and orphans detected only by it, pooled over the class's sites and as the median site share.",
             e2_channels),
    Artifact("t2_e2_composition", "RQ2", "E2", "table", "Orphans by the channels that detect them",
             "Share of each class's orphans detected only by one channel, or by several.",
             e2_composition),
    Artifact("f2_e2_composition", "RQ2", "E2", "figure", "Orphans detected only by one channel",
             "100% stacked bars: the share of orphans each channel alone detects, and the share several channels detect, per class and for all sites.",
             e2_figure),
    Artifact("t3_e3_paired_raw", "RQ3", "E3", "table", "LinkLens against the baselines (total ΔPR)",
             "Top-k fixes applied together; LinkLens against each baseline across sites, per k: paired Wilcoxon signed-rank (two-sided, zero differences dropped), rank-biserial r, Holm over the baselines within k.",
             e3_paired("raw")),
    Artifact("t3_e3_paired_relative", "RQ3", "E3", "table", "LinkLens against the baselines (relative)",
             "As the previous table, with each site's total ΔPR divided by its targets' PageRank before the fixes (scale-free across site sizes).",
             e3_paired("relative")),
    Artifact("t3_e3_by_class", "RQ3", "E3", "table", "Fixes against baselines, per class",
             "Per class and k: each method's median total ΔPR [quartiles] and the paired comparison with LinkLens.",
             e3_by_class),
    Artifact("f3_e3_paired", "RQ3", "E3", "figure", "LinkLens minus each baseline, per site",
             "Per site, LinkLens's relative gain minus each baseline's (one panel per k); above zero LinkLens's top-k raises the targets' PageRank more.",
             e3_figure),
    Artifact("t4_e4_summary", "RQ4", "E4", "table", "Re-crawl stability",
             "Two crawls 14 days apart: page shares (unchanged, changed, crawled once for a site or a crawl reason) and each metric observed, with only the site's changes, and on identical pages (the method's own instability).",
             e4_summary),
    Artifact("t4_e4_attribution", "RQ4", "E4", "table", "What explains the re-crawl disagreement",
             "Median disagreement (1 − agreement) observed, with only the site's changes and on identical pages, and the site's share of the observed.",
             e4_attribution),
    Artifact("f4_e4_attribution", "RQ4", "E4", "figure", "Re-crawl disagreement: site or method",
             "Median disagreement per class and metric: observed, with only the site's changes, and on identical pages.",
             e4_figure),
    Artifact("t4_e5_calibration", "RQ4", "E5", "table", "Calibration against Screaming Frog",
             "URLs mapped through P0 and the audit's policy; per class: URL Jaccard, inlink Spearman (recomputed and Screaming Frog's column), depth agreement and orphan Jaccard, median over sites [quartiles].",
             e5_calibration),
    Artifact("t4_e5_large_categories", "RQ4", "E5", "table", "Large disagreements with Screaming Frog, explained",
             "Every disagreement category that is large on at least one site, with its pooled count, share and explanation.",
             e5_large),
    Artifact("t5_e6_results", "RQ5", "E6", "table", "Link-masking recovery",
             "10–20% of editorial links masked (links and anchors removed, REF and embeddings rebuilt), five repeats per site; each method's MRR, Recall@k and AUC, mean over sites [bootstrap 95% CI].",
             e6_results),
    Artifact("t5_e6_c5", "RQ5", "E6", "table", "C5: hybrid against cosine",
             "The refutation test for C5: the REF-gated hybrid against cosine across sites, Wilcoxon signed-rank one-sided (hybrid better) and two-sided, rank-biserial r, Holm over MRR (primary), R@10 and AUC.",
             e6_c5),
    Artifact("t5_e6_c5_by_class", "RQ5", "E6", "table", "C5 per class",
             "The C5 test within each class.",
             e6_c5_by_class),
    Artifact("f5_e6_methods", "RQ5", "E6", "figure", "Recovery by method",
             "Each method's E6 MRR, mean over sites with a bootstrap 95% CI; the random baseline dashed.",
             e6_figure),
    Artifact("t5_e7_ablation", "RQ5", "E7", "table", "σ ablation",
             "Each σ variant at the default ε and α: top-k overlap with the default, E3 ΔPR and gain over random, and E6 recovery; mean over sites [bootstrap 95% CI], all sites and per class.",
             e7_ablation),
    Artifact("t5_e7_sigma_pairs", "RQ5", "E7", "table", "Top-k overlap between σ variants",
             "The σ variants' pairwise top-k Jaccard at the default ε and α, mean over sites.",
             e7_pairs),
    Artifact("t5_e7_scoring", "RQ5", "E7", "table", "S against importance-weighted S_imp",
             "Each σ at the default ε and α under S and under S_imp = S × importance(target) (L12, heuristic weights): E3 gain over random for the top-k, the difference, and S_imp's top-k overlap with the default; mean over sites [bootstrap 95% CI].",
             e7_scoring),
    Artifact("f5_e7_epsilon", "RQ5", "E7", "figure", "Sensitivity to ε",
             "Top-k overlap with the default, E3 gain over random and E6 MRR across the ε sweep, one line per σ; the default ε dashed.",
             e7_curves("epsilon")),
    Artifact("f5_e7_alpha", "RQ5", "E7", "figure", "Sensitivity to α",
             "Top-k overlap with the default and E3 gain over random across the α sweep, one line per σ (α does not enter E6); the default α dashed.",
             e7_curves("alpha")),
]


# ---------- running ----------


@dataclass
class Outcome:
    artifact: Artifact
    files: list[str] = field(default_factory=list)
    skipped: str | None = None


def _write_table(a: Artifact, built: object, out: Path) -> list[str]:
    tex_df, csv_df = built if isinstance(built, tuple) else (built, built)
    (out / "tables").mkdir(parents=True, exist_ok=True)
    csv_path = out / "tables" / f"{a.id}.csv"
    tex_path = out / "tables" / f"{a.id}.tex"
    flat(csv_df).to_csv(csv_path, index=False, lineterminator="\n")
    tex_path.write_text(to_latex(tex_df, f"{a.title}. {a.caption}", f"tab:{a.id}"), encoding="utf-8", newline="\n")
    return [f"tables/{a.id}.csv", f"tables/{a.id}.tex"]


def _write_figure(a: Artifact, fig, out: Path) -> list[str]:
    import matplotlib.pyplot as plt

    (out / "figures").mkdir(parents=True, exist_ok=True)
    paths = style.save(fig, out / "figures" / a.id)
    plt.close(fig)
    snippet = "\n".join(
        [
            r"\begin{figure}[t]",
            r"\centering",
            rf"\includegraphics[width=\linewidth]{{figures/{a.id}.pdf}}",
            rf"\caption{{{escape(a.title)}. {escape(a.caption)}}}",
            rf"\label{{fig:{a.id}}}",
            r"\end{figure}",
            "",
        ]
    )
    (out / "figures" / f"{a.id}.tex").write_text(snippet, encoding="utf-8", newline="\n")
    return [f"figures/{p.name}" for p in paths] + [f"figures/{a.id}.tex"]


def _matplotlib_error() -> str | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot  # noqa: F401
    except Exception as e:  # a blocked compiled extension, or no matplotlib
        return f"matplotlib cannot load: {type(e).__name__}: {e}"
    return None


def make_all(batch_dir: str | Path, out_dir: str | Path, options: Options = Options()) -> list[Outcome]:
    """Build every artefact of ARTIFACTS into out_dir, then README.md and manifest.json."""
    batch = corpus.load_batch(batch_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    mpl_error = _matplotlib_error()
    outcomes: list[Outcome] = []
    for a in ARTIFACTS:
        o = Outcome(a)
        try:
            if a.kind == "figure" and mpl_error is not None:
                raise Skip(mpl_error)
            if a.kind == "figure":
                with style.style():
                    o.files = _write_figure(a, a.build(batch, options), out)
            else:
                o.files = _write_table(a, a.build(batch, options), out)
        except Skip as s:
            o.skipped = str(s)
        except style.UnknownClass as e:
            o.skipped = e.args[0]
        outcomes.append(o)
    (out / "README.md").write_text(readme(batch, Path(batch_dir), outcomes, options), encoding="utf-8", newline="\n")
    _write_manifest(Path(batch_dir), out, outcomes, options)
    return outcomes


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_manifest(batch_dir: Path, out: Path, outcomes: list[Outcome], options: Options) -> None:
    inputs = {p.name: _sha256(p) for p in sorted(batch_dir.glob("*.csv"))}
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "batch": str(batch_dir),
        "options": {"k": options.k, "alpha": options.alpha},
        "inputs": inputs,
        "artifacts": [
            {"id": o.artifact.id, "rq": o.artifact.rq, "experiment": o.artifact.experiment,
             "kind": o.artifact.kind, "files": o.files, "skipped": o.skipped}
            for o in outcomes
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")


def _batch_facts(batch_dir: Path) -> list[str]:
    """The batch's provenance, from its manifest.json when there is one."""
    path = batch_dir / "manifest.json"
    if not path.exists():
        return []
    m = json.loads(path.read_text(encoding="utf-8"))
    git = m.get("git", {})
    facts = [
        f"- Commit: `{git.get('commit')}`{' (with uncommitted changes)' if git.get('dirty') else ''}",
        f"- Seed: {m.get('seed')}; config SHA-256 `{str(m.get('configSha256', ''))[:16]}…`",
        f"- Embedding model: {m.get('model', {}).get('name')} (SHA-256 `{str(m.get('model', {}).get('sha256'))[:16]}…`)",
        f"- User-Agent: {m.get('userAgent')}",
    ]
    return facts


def readme(batch: corpus.Batch, batch_dir: Path, outcomes: list[Outcome], options: Options) -> str:
    """The results README: every table and figure mapped to its RQ and experiment."""
    lines = [
        f"# Results: batch {batch.batch_id}",
        "",
        "Generated by `python make_all.py` from the batch's exported CSVs (see `manifest.json` for "
        "the inputs' SHA-256). Tables are in `tables/` (`.csv` and a booktabs `.tex`); figures in "
        "`figures/` (`.pdf`, `.png` and a `.tex` snippet). Do not edit these files by hand: "
        "change the analysis and run it again.",
        "",
        f"- Sites: {len(batch.sites)} ({', '.join(f'{(batch.sites['architecture_class'] == c).sum()} {style.class_label(c)}' for c in style.ordered_classes(list(batch.sites['architecture_class'].unique())))})",
        f"- Options: top-k = {options.k}, α (tests) = {options.alpha}",
        *_batch_facts(batch_dir),
        "",
        "## Map",
        "",
        "| Output | RQ | Experiment | Kind | Title | Files |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for o in outcomes:
        a = o.artifact
        files = ", ".join(f"[{Path(f).name}]({f})" for f in o.files) if o.files else f"skipped: {o.skipped}"
        lines.append(f"| `{a.id}` | {a.rq} | {a.experiment} | {a.kind} | {a.title.replace('|', r'\|')} | {files} |")
    for rq in RQS:
        mine = [o for o in outcomes if o.artifact.rq == rq.id]
        if not mine:
            continue
        lines += ["", f"## {rq.id}: {rq.title}", "", f"*{rq.question}* Experiments: {', '.join(rq.experiments)}.", ""]
        if rq.id == "RQ5" and not batch.e6.empty:
            lines += [f"**Headline (C5):** {e6.c5_verdict(e6.paired_test(batch.e6), options.alpha)}", ""]
        for o in mine:
            a = o.artifact
            where = ", ".join(f"`{f}`" for f in o.files) if o.files else f"*skipped — {o.skipped}*"
            lines.append(f"- **{a.id}** ({a.experiment}, {a.kind}) — {a.title}. {a.caption} {where}")
    skipped = [o for o in outcomes if o.skipped is not None]
    lines += ["", "## Skipped", ""]
    lines += [f"- `{o.artifact.id}`: {o.skipped}" for o in skipped] or ["Nothing: every output was generated."]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python make_all.py", description=__doc__.split("\n\n")[0])
    p.add_argument("batch", help="a corpus batch directory (after `corpus export`)")
    p.add_argument("--out", help="output directory (default: <batch>/results)")
    p.add_argument("--k", type=int, default=10, help="top-k for E7's tables and curves (default 10)")
    p.add_argument("--alpha", type=float, default=0.05, help="significance level for the C5 verdict")
    args = p.parse_args(argv)
    out = Path(args.out) if args.out else Path(args.batch) / "results"
    outcomes = make_all(args.batch, out, Options(k=args.k, alpha=args.alpha))
    made = sum(1 for o in outcomes if o.skipped is None)
    print(f"{made} of {len(outcomes)} outputs written to {out} (see {out / 'README.md'})")
    for o in outcomes:
        if o.skipped is not None:
            print(f"  skipped {o.artifact.id}: {o.skipped}", file=sys.stderr)
    return 0
