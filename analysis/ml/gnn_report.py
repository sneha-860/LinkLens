"""GraphSAGE report: E6 recovery against REF, cosine and the hybrid σ (held-out sites), runtime,
and, when both L13 model directories are given, the ranker with and without the feature."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from linklens_analysis.corpus import holm

from . import report as ranker_report

BASELINES = ["hybrid", "cosine", "ref"]
LABELS = {"graphsage": "GraphSAGE", "hybrid": "Hybrid (REF-gated cosine)", "cosine": "Cosine", "ref": "REF"}
METRICS = ["mrr", "recall@10", "auc"]


def site_table(metrics: pd.DataFrame) -> pd.DataFrame:
    """Per site × method: MRR, recall@k and AUC, each the mean over the site's repeats."""
    return ranker_report.e6_site_table(metrics)


def comparison(metrics: pd.DataFrame) -> pd.DataFrame:
    """GraphSAGE vs each baseline across sites, per metric (two-sided Wilcoxon, zero differences
    dropped); Holm over the three baselines within each metric."""
    parts = []
    for b in BASELINES:
        t = ranker_report.e6_paired(metrics, "graphsage", b)
        t = t[t.index.isin(METRICS)].rename(columns={f"mean {b}": "mean baseline"})
        parts.append(t.assign(baseline=LABELS[b]).reset_index())
    out = pd.concat(parts, ignore_index=True)
    out["p_holm (over baselines)"] = np.nan
    for m, g in out.groupby("metric"):
        out.loc[g.index, "p_holm (over baselines)"] = holm(g["p (two-sided)"].to_numpy())
    cols = ["metric", "baseline", "sites", "mean graphsage", "mean baseline", "mean difference",
            "wins/ties/losses", "p (two-sided)", "p_holm (over baselines)", "r (rank-biserial)"]
    return out[cols].set_index(["metric", "baseline"])


def runtime_table(runtime: pd.DataFrame) -> pd.DataFrame:
    t = runtime.set_index("site")[["nodes", "body_edges", "training_graphs", "export_ms", "train_ms", "score_ms"]]
    total = t[["export_ms", "train_ms", "score_ms"]].sum().rename("total")
    return pd.concat([t, total.to_frame().T])


def ranker_comparison(plain: Path, with_gs: Path) -> pd.DataFrame:
    a = pd.read_csv(plain / "e6_metrics.csv")
    b = pd.read_csv(with_gs / "e6_metrics.csv")
    b = b[b["method"] == "learned"].assign(method="learned+graphsage")
    both = pd.concat([a[a["method"] == "learned"], b], ignore_index=True)
    return ranker_report.e6_paired(both, "learned+graphsage", "learned")


def verdict(cmp: pd.DataFrame, alpha: float = 0.05) -> list[str]:
    lines = []
    for b in BASELINES:
        key = ("mrr", LABELS[b])
        if key not in cmp.index:
            continue
        r = cmp.loc[key]
        p = r["p_holm (over baselines)"]
        d = r["mean difference"]
        if not np.isnan(p) and p < alpha:
            word = "better than" if d > 0 else "worse than"
            lines.append(f"GraphSAGE is {word} {LABELS[b]} on MRR ({d:+.3f}, Holm p = {p:.3g}, {r['wins/ties/losses']} sites).")
        else:
            lines.append(
                f"No significant MRR difference between GraphSAGE and {LABELS[b]} ({d:+.3f}, Holm p = {p:.3g}, "
                f"{r['wins/ties/losses']} sites)."
            )
    return lines


def report(gnn_dir: str | Path, ranker: str | Path | None = None, ranker_gs: str | Path | None = None) -> str:
    d = Path(gnn_dir)
    metrics = pd.read_csv(d / "e6_metrics.csv")
    runtime = pd.read_csv(d / "runtime.csv")
    md = ranker_report._md
    parts = [
        "# GraphSAGE link predictor (E6)",
        "",
        "Leave-one-site-out: each site is scored by a GraphSAGE trained on the other sites' masked "
        "repeat graphs. E6 metrics are per query (expected under random tie-breaking), averaged over "
        "a site's repeats.",
        "",
        "## Per site",
        "",
        md(site_table(metrics).set_index(["site", "method"]).drop(columns="architecture_class")),
        "",
        "## GraphSAGE vs REF, cosine and the hybrid across sites",
        "",
        md(comparison(metrics)),
        "",
        "## Runtime (ms; one CPU thread)",
        "",
        md(runtime_table(runtime)),
        "",
    ]
    cmp = comparison(metrics)
    lines = verdict(cmp)
    if ranker is not None and ranker_gs is not None:
        rc = ranker_comparison(Path(ranker), Path(ranker_gs))
        parts += ["## L13 ranker with the graphsage feature vs without (E6)", "", md(rc), ""]
        if "mrr" in rc.index:
            r = rc.loc["mrr"]
            lines.append(
                f"L13 ranker + graphsage vs without: MRR {r['mean difference']:+.3f}, "
                f"{r['wins/ties/losses']} sites (p = {r['p (two-sided)']:.3g})."
            )
    lines.append(
        "The graphsage method and feature stay off by default (config.graphsageEnabled). E6 labels "
        "are links the site already had, a proxy for editorial relevance."
    )
    parts += ["## Verdict", "", *[f"- {l}" for l in lines], ""]
    text = "\n".join(parts)
    (d / "REPORT.md").write_text(text, encoding="utf-8")
    return text
