"""L13 report: learned priority vs S on E6 recovery (held-out sites) and E3 gain, plus the global
TreeSHAP summary. Everything is computed from the files `train` and `l13 import` wrote to the
model directory, so the report can be re-run without retraining."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from linklens_analysis import style
from linklens_analysis.corpus import holm
from linklens_analysis.e3 import rank_biserial

METHOD_LABELS = {"learned": "Learned (LightGBM)", "S": "S (refGateCosine)", "hybrid": "σ hybrid alone", "random": "Random"}
PRIMARY = "mrr"
SHAP_FEATURES = 12  # features drawn in the summary plot (by mean |SHAP|)


def e6_site_table(metrics: pd.DataFrame) -> pd.DataFrame:
    """Per site × method: queries, MRR, recall@k and AUC (the held-out fold's means)."""
    wide = metrics.pivot_table(index=["site", "architecture_class", "method"], columns="metric", values="value")
    return wide.reset_index()


def e6_paired(metrics: pd.DataFrame, a: str = "learned", b: str = "S") -> pd.DataFrame:
    """a vs b across sites per metric: Wilcoxon signed-rank (two-sided and a > b), zero
    differences dropped, rank-biserial r, wins/ties/losses; Holm over the metrics."""
    wide = e6_site_table(metrics).set_index(["site", "method"])
    names = [c for c in wide.columns if c == "mrr" or c.startswith("recall@") or c == "auc"]
    rows = []
    for m in names:
        x = wide.xs(a, level="method")[m]
        y = wide.xs(b, level="method")[m]
        d = (x - y).dropna().to_numpy()
        nz = d[d != 0]
        p_two = p_gt = np.nan
        if nz.size:
            p_two = float(stats.wilcoxon(nz, alternative="two-sided").pvalue)
            p_gt = float(stats.wilcoxon(nz, alternative="greater").pvalue)
        rows.append(
            {
                "metric": m,
                "sites": int(d.size),
                f"mean {a}": float(x.mean()),
                f"mean {b}": float(y.mean()),
                "mean difference": float(d.mean()) if d.size else np.nan,
                "wins/ties/losses": f"{int((d > 0).sum())}/{int((d == 0).sum())}/{int((d < 0).sum())}",
                "p (a > b)": p_gt,
                "p (two-sided)": p_two,
                "r (rank-biserial)": rank_biserial(d),
            }
        )
    out = pd.DataFrame(rows).set_index("metric")
    if not out.empty:
        out["p_holm (two-sided)"] = holm(out["p (two-sided)"].to_numpy())
    return out


def e3_table(e3: pd.DataFrame) -> pd.DataFrame:
    """Per k × method: mean and median total ΔPR over the targets across sites, and the per-site
    wins of learned over S."""
    rows = []
    for k, g in e3.groupby("k", sort=True):
        wide = g.pivot_table(index="site", columns="method", values="totalDeltaPr")
        for method in [m for m in ("learned", "S", "random") if m in wide]:
            rows.append(
                {
                    "k": int(k),
                    "method": METHOD_LABELS[method],
                    "sites": int(wide[method].notna().sum()),
                    "mean total ΔPR": float(wide[method].mean()),
                    "median total ΔPR": float(wide[method].median()),
                }
            )
        if {"learned", "S"} <= set(wide):
            d = (wide["learned"] - wide["S"]).dropna().to_numpy()
            nz = d[d != 0]
            rows.append(
                {
                    "k": int(k),
                    "method": "learned − S",
                    "sites": int(d.size),
                    "mean total ΔPR": float(d.mean()) if d.size else np.nan,
                    "median total ΔPR": float(np.median(d)) if d.size else np.nan,
                    "wins/ties/losses": f"{int((d > 0).sum())}/{int((d == 0).sum())}/{int((d < 0).sum())}",
                    "p (two-sided)": float(stats.wilcoxon(nz).pvalue) if nz.size else np.nan,
                }
            )
    return pd.DataFrame(rows)


def shap_importance(shap: pd.DataFrame, features: list[str]) -> pd.DataFrame:
    """Mean |SHAP| per feature over the held-out E6 sample, largest first (overall and the
    share of the total)."""
    cols = [f for f in features if f in shap]
    m = shap[cols].abs().mean().sort_values(ascending=False, kind="mergesort")
    return pd.DataFrame({"mean |SHAP|": m, "share": m / m.sum()})


def shap_summary_figure(shap: pd.DataFrame, features: list[str], top: int = SHAP_FEATURES):
    """Beeswarm: one row per feature (by mean |SHAP|), each point a held-out E6 candidate at its
    SHAP value, coloured by the feature's value as a within-feature percentile (sequential ramp,
    low light → high dark; categorical features in neutral grey)."""
    import matplotlib.pyplot as plt

    imp = shap_importance(shap, features).head(top)
    names = list(imp.index)[::-1]
    rng = np.random.default_rng(0)
    cmap = style.sequential_cmap()
    with style.style():
        fig, ax = plt.subplots(figsize=(style.DOUBLE_COLUMN, 0.32 * len(names) + 1.2))
        ax.axvline(0, color=style.baseline, linewidth=1, zorder=0)
        for y, f in enumerate(names):
            x = shap[f].to_numpy(dtype=float)
            vcol = f"value__{f}"
            raw = shap[vcol] if vcol in shap else pd.Series(np.nan, index=shap.index)
            numeric = pd.to_numeric(raw, errors="coerce")
            jitter = rng.uniform(-0.3, 0.3, size=x.size)
            if numeric.notna().any():
                pct = numeric.rank(pct=True).to_numpy()
                colours = [cmap(p) if not np.isnan(p) else style.muted for p in pct]
            else:
                colours = style.muted
            ax.scatter(x, y + jitter, s=4, c=colours, linewidths=0, alpha=0.7, rasterized=True)
        ax.set_yticks(range(len(names)), names)
        ax.set_xlabel("SHAP value (contribution to the learned score)")
        sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(0, 1))
        cb = fig.colorbar(sm, ax=ax, pad=0.01, fraction=0.03)
        cb.set_label("feature value (percentile)")
        cb.outline.set_visible(False)
        ax.set_title("L13: global TreeSHAP summary (held-out sites)", loc="left")
    return fig


def _md(df: pd.DataFrame, floatfmt: str = ".4g") -> str:
    return df.to_markdown(floatfmt=floatfmt)


def verdict(paired: pd.DataFrame, e3: pd.DataFrame | None, alpha: float = 0.05) -> str:
    lines = []
    if PRIMARY in paired.index:
        r = paired.loc[PRIMARY]
        diff = r["mean difference"]
        p = r["p_holm (two-sided)"]
        sig = not np.isnan(p) and p < alpha
        if sig and diff > 0:
            lines.append(f"E6: the learned priority recovers masked links better than S (MRR {diff:+.3f}, Holm p = {p:.3g}, {r['wins/ties/losses']} sites).")
        elif sig and diff < 0:
            lines.append(f"E6: the learned priority is worse than S (MRR {diff:+.3f}, Holm p = {p:.3g}, {r['wins/ties/losses']} sites).")
        else:
            lines.append(
                f"E6: no significant difference between learned and S (MRR {diff:+.3f}, Holm p = {p:.3g}, "
                f"{r['wins/ties/losses']} sites). With {int(r['sites'])} sites the smallest two-sided p is {2 / 2 ** int(r['sites']):.3g}."
            )
    if e3 is not None and not e3.empty:
        d = e3[e3["method"] == "learned − S"]
        for _, row in d.iterrows():
            lines.append(
                f"E3 k = {row['k']}: learned − S total ΔPR mean {row['mean total ΔPR']:+.3g}, "
                f"{row['wins/ties/losses']} sites (p = {row['p (two-sided)']:.3g})."
            )
    lines.append(
        "S remains the default. E6 labels are a proxy for editorial relevance (an existing link that "
        "was hidden); the learned model optimises that proxy, and ω of an existing edge is always 0 "
        "in its training rows (E6 candidates never link to the target)."
    )
    return "\n".join(f"- {l}" for l in lines)


def report(model_dir: str | Path, figures: bool = True) -> str:
    d = Path(model_dir)
    model = pd.read_json(d / "model.json", typ="series")
    features = list(model["features"])
    metrics = pd.read_csv(d / "e6_metrics.csv")
    parts = ["# L13 learned prioritiser", "", f"Cross-validation: {model['cv']} ({len(model['sites'])} sites).", ""]

    site_table = e6_site_table(metrics)
    parts += ["## E6 recovery per held-out site", "", _md(site_table.set_index(["site", "method"]).drop(columns="architecture_class")), ""]
    paired = e6_paired(metrics)
    parts += ["## Learned vs S across sites (E6)", "", _md(paired), ""]
    parts += ["## Learned vs the σ hybrid alone (E6)", "", _md(e6_paired(metrics, "learned", "hybrid")), ""]

    e3 = None
    if (d / "e3.csv").exists():
        e3 = e3_table(pd.read_csv(d / "e3.csv"))
        parts += ["## E3: total ΔPR of the top-k applied together", "", _md(e3.set_index(["k", "method"])), ""]
    else:
        parts += ["## E3", "", "Not available: run `l13 import` first (it writes e3.csv).", ""]

    if (d / "e8_ratings.csv").exists():
        e8 = pd.read_csv(d / "e8_ratings.csv")
        parts += ["## E8 human ratings (second label set)", "", _md(e8.groupby("method")[["ndcg@10", "precision@10"]].mean()), ""]
    else:
        parts += ["## E8 human ratings", "", "No second label set: fewer than two sites have E8 ratings.", ""]

    if (d / "shap_sample.csv").exists():
        shap = pd.read_csv(d / "shap_sample.csv")
        parts += ["## Global feature importance (mean |SHAP|, held-out E6 sample)", "", _md(shap_importance(shap, features)), ""]
        if figures:
            try:
                fig = shap_summary_figure(shap, features)
                saved = style.save(fig, d / "figures" / "shap_summary")
                parts += [f"Figure: {', '.join(p.name for p in saved)}", ""]
            except ImportError as e:  # matplotlib unavailable
                parts += [f"Figure skipped: {e}", ""]
    parts += ["## Verdict", "", verdict(paired, e3), ""]
    text = "\n".join(parts)
    (d / "REPORT.md").write_text(text, encoding="utf-8")
    return text
