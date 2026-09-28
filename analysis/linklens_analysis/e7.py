"""E7, the σ / ε / α ablation across the corpus (e7.csv, e7_sigma_pairs.csv of a batch export).

Per site, the fixes were ranked again for each σ variant (cosineOnly, refOnly, refGateCosine,
blended) at the default ε and α, along an ε sweep (each σ, default α) and along an α sweep
(each σ, default ε): packages/eval/src/e7-ablation.ts. For each setting:

- topk_jaccard_default: overlap of the top-k fixes with the default setting's;
- e3_linklens@k / e3_random@k / e3_gain@k: E3's joint ΔPR of LinkLens's top-k, of random, and
  their difference;
- e6_mrr / e6_recall@k / e6_auc: E6 recovery of the σ variant (the hybrid gated at the setting's
  ε; α does not enter E6).

The scoring sweep (L12): each σ at the default ε and α under S and under S_imp = S ×
importance(target) (`scoring` column; exports without it are all S). E6 does not change under
S_imp by construction (importance is constant within one target's donors).

A site's value is used as is; tables and curves average over sites.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd

from . import RANDOM_SEED, style

SIGMAS = ["refGateCosine", "cosineOnly", "refOnly", "blended"]
SIGMA_LABELS = {
    "refGateCosine": "Hybrid (REF-gated cosine)",
    "cosineOnly": "Cosine only",
    "refOnly": "REF only",
    "blended": "Blended",
}
# Four series drawn together (curves): blue, orange, aqua, violet validate for every pair
# (CVD ΔE ≥ 9, normal-vision ΔE ≥ 16); aqua is under 3:1 on the surface, so every line also
# has its own marker and the figure a legend (and the report the same numbers as tables).
SIGMA_COLOURS = {
    "refGateCosine": "#2a78d6",
    "cosineOnly": "#eb6834",
    "refOnly": "#1baf7a",
    "blended": "#4a3aa7",
}
SIGMA_MARKERS = {"refGateCosine": "o", "cosineOnly": "s", "refOnly": "^", "blended": "D"}
ALL = "all sites"
METRIC_LABELS = {
    "topk_jaccard_default": "Top-k overlap with the default",
    "e3_gain": "E3 gain over random (ΔPR)",
    "e3_linklens": "E3 total ΔPR (LinkLens)",
    "e6_mrr": "E6 MRR",
    "e6_recall@10": "E6 Recall@10",
    "e6_auc": "E6 AUC",
}


SETTING = ["architecture_class", "site_id", "sigma", "epsilon", "alpha", "scoring"]


def with_scoring(e7: pd.DataFrame) -> pd.DataFrame:
    """The export with a `scoring` column (exports from before L12 have none: all S)."""
    if "scoring" in e7.columns:
        return e7.assign(scoring=e7["scoring"].fillna("S"))
    return e7.assign(scoring="S")


def site_values(e7: pd.DataFrame) -> pd.DataFrame:
    """One row per site × setting (index: architecture_class, site_id, sigma, epsilon, alpha,
    scoring), one column per metric, plus the setting's `sweeps` and `is_default`."""
    e7 = with_scoring(e7)
    w = e7.pivot_table(index=SETTING, columns="metric", values="value", observed=True)
    w.columns.name = None
    meta = e7.drop_duplicates(SETTING[1:]).set_index(SETTING)[["sweeps", "is_default"]]
    return w.join(meta)


def defaults(e7: pd.DataFrame) -> tuple[float, float]:
    """The default ε and α (the setting marked is_default)."""
    d = e7[e7["is_default"].astype(bool)]
    return float(d["epsilon"].iloc[0]), float(d["alpha"].iloc[0])


def _mean_ci(values: pd.Series, n: int = 2000) -> str:
    v = values.dropna().to_numpy(dtype=float)
    if v.size == 0:
        return "n/a"
    if v.size == 1:
        return f"{v[0]:.3g}"
    boots = np.random.default_rng(RANDOM_SEED).choice(v, size=(n, v.size)).mean(axis=1)
    lo, hi = np.quantile(boots, [0.025, 0.975])
    return f"{v.mean():.3g} [{lo:.3g}, {hi:.3g}]"


def ablation_table(e7: pd.DataFrame, k: int = 10, recall_k: int = 10, scope: str | None = None) -> pd.DataFrame:
    """The σ ablation at the default ε and α: one row per σ variant, the mean over sites (and a
    seeded bootstrap 95% CI) of the top-k overlap with the default σ, E3's LinkLens ΔPR and gain
    over random (top-k), and E6's MRR, Recall@k and AUC."""
    w = site_values(e7)
    eps, alpha = defaults(e7)
    if scope is not None and scope != ALL:
        w = w.xs(scope, level="architecture_class", drop_level=False)
    sweep = w[w["sweeps"].str.contains("sigma")]
    cols = {
        "Top-k overlap with default": "topk_jaccard_default",
        f"E3 ΔPR@{k}": f"e3_linklens@{k}",
        f"E3 gain@{k}": f"e3_gain@{k}",
        "E6 MRR": "e6_mrr",
        f"E6 R@{recall_k}": f"e6_recall@{recall_k}",
        "E6 AUC": "e6_auc",
    }
    rows = []
    for sigma in [s for s in SIGMAS if s in set(sweep.index.get_level_values("sigma"))]:
        s = sweep.xs(sigma, level="sigma")
        row: dict[str, object] = {"σ": SIGMA_LABELS[sigma], "sites": s.index.get_level_values("site_id").nunique()}
        for label, metric in cols.items():
            row[label] = _mean_ci(s[metric]) if metric in s else "n/a"
        rows.append(row)
    out = pd.DataFrame(rows).set_index("σ")
    out.attrs["setting"] = f"ε = {eps:g}, α = {alpha:g}"
    return out


def scoring_table(e7: pd.DataFrame, k: int = 10) -> pd.DataFrame:
    """S against S_imp (L12) for each σ at the default ε and α: E3 gain over random (top-k) under
    each, their difference, and S_imp's top-k overlap with the default setting's fixes; mean over
    sites [bootstrap 95% CI]. Empty when the export has no S_imp rows."""
    w = site_values(e7)
    w = w[w["sweeps"].str.contains("scoring")]
    if w.empty or "S_imp" not in set(w.index.get_level_values("scoring")):
        return pd.DataFrame()
    gain = f"e3_gain@{k}"
    rows = []
    for sigma in [x for x in SIGMAS if x in set(w.index.get_level_values("sigma"))]:
        g = w.xs(sigma, level="sigma")
        by = {sc: g.xs(sc, level="scoring") for sc in ("S", "S_imp") if sc in set(g.index.get_level_values("scoring"))}
        if len(by) < 2:
            continue
        s_, imp = by["S"], by["S_imp"]
        both = s_.index.intersection(imp.index)
        diff = (imp.loc[both, gain] - s_.loc[both, gain]) if gain in s_ and gain in imp else pd.Series(dtype=float)
        rows.append(
            {
                "σ": SIGMA_LABELS[sigma],
                "sites": len(both),
                f"E3 gain@{k} (S)": _mean_ci(s_[gain]) if gain in s_ else "n/a",
                f"E3 gain@{k} (S_imp)": _mean_ci(imp[gain]) if gain in imp else "n/a",
                "S_imp − S": _mean_ci(diff),
                "S_imp top-k overlap with default": _mean_ci(imp["topk_jaccard_default"])
                if "topk_jaccard_default" in imp
                else "n/a",
            }
        )
    return pd.DataFrame(rows).set_index("σ") if rows else pd.DataFrame()


def sigma_pair_matrix(pairs: pd.DataFrame) -> pd.DataFrame:
    """The σ variants' pairwise top-k Jaccard, averaged over sites, as a symmetric matrix."""
    present = [s for s in SIGMAS if s in set(pairs["sigma_a"]) | set(pairs["sigma_b"])]
    m = pd.DataFrame(np.eye(len(present)), index=present, columns=present)
    means = pairs.groupby(["sigma_a", "sigma_b"])["jaccard"].mean()
    for (a, b), v in means.items():
        m.loc[a, b] = m.loc[b, a] = v
    m.index = [SIGMA_LABELS[s] for s in m.index]
    m.columns = [SIGMA_LABELS[s] for s in m.columns]
    return m


def curve(e7: pd.DataFrame, sweep: str, metric: str, scope: str | None = None) -> pd.DataFrame:
    """A sensitivity curve: for each σ (column) and each value of the swept parameter (index),
    the metric's mean over sites. `sweep` is "epsilon" or "alpha"."""
    if sweep not in ("epsilon", "alpha"):
        raise ValueError("sweep must be 'epsilon' or 'alpha'")
    w = site_values(e7)
    if scope is not None and scope != ALL:
        w = w.xs(scope, level="architecture_class", drop_level=False)
    w = w[w["sweeps"].str.contains(sweep)]
    if metric not in w:
        return pd.DataFrame()
    means = w[metric].groupby(level=["sigma", sweep]).mean().unstack("sigma")
    return means[[s for s in SIGMAS if s in means.columns]]


def curves_figure(
    e7: pd.DataFrame,
    sweep: str,
    metrics: Sequence[str],
    scope: str | None = None,
):
    """Small multiples: one panel per metric, one line per σ (colour and marker) across the
    swept parameter, the default value marked, one legend above."""
    import matplotlib.pyplot as plt

    eps, alpha = defaults(e7)
    default = eps if sweep == "epsilon" else alpha
    shown = [m for m in metrics if not curve(e7, sweep, m, scope).empty]
    fig, axes = plt.subplots(1, len(shown), figsize=(style.DOUBLE_COLUMN, 2.6), squeeze=False)
    for ax, metric in zip(axes[0], shown):
        c = curve(e7, sweep, metric, scope)
        for sigma in c.columns:
            ax.plot(
                c.index,
                c[sigma],
                color=SIGMA_COLOURS[sigma],
                marker=SIGMA_MARKERS[sigma],
                markersize=4.5,
                markeredgecolor=style.surface,
                linewidth=1.8,
                label=SIGMA_LABELS[sigma],
            )
        ax.axvline(default, color=style.muted, linewidth=0.8, linestyle=(0, (3, 3)), zorder=0)
        ax.set_xlabel("ε (REF cutoff)" if sweep == "epsilon" else "α (diagnosis threshold)")
        base = metric.split("@")[0]
        ax.set_title(METRIC_LABELS.get(metric, METRIC_LABELS.get(base, metric)), fontsize=9.5)
        ax.set_xticks(list(c.index))
        ax.tick_params(axis="x", labelsize=7.5)
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, ncols=len(labels), loc="lower center", bbox_to_anchor=(0.5, 1.0), frameon=False)
    return fig


def figures(e7: pd.DataFrame, out_dir: str | Path, k: int = 10) -> list[Path]:
    """The ε and α sensitivity curves (PDF + PNG) in the shared style."""
    import matplotlib.pyplot as plt

    written: list[Path] = []
    with style.style():
        for sweep, metrics in [
            ("epsilon", ["topk_jaccard_default", f"e3_gain@{k}", "e6_mrr"]),
            ("alpha", ["topk_jaccard_default", f"e3_gain@{k}"]),
        ]:
            fig = curves_figure(e7, sweep, metrics)
            written += style.save(fig, Path(out_dir) / f"e7_{sweep}_curves")
            plt.close(fig)
    return written


def report(directory: str | Path, k: int = 10) -> str:
    """Markdown: the σ ablation table (all sites, then each class), the σ pairwise overlap, and
    the ε and α sensitivity curves as tables."""
    from .corpus import load_batch

    batch = load_batch(directory)
    if batch.e7.empty:
        return (
            f"## E7 σ / ε / α ablation, batch {batch.batch_id}\n\n"
            "No E7 results yet: `corpus export` computes them for every completed site.\n"
        )
    table = ablation_table(batch.e7, k)
    parts = [
        f"## E7 σ / ε / α ablation, batch {batch.batch_id}",
        "",
        f"### σ variants ({table.attrs['setting']}; mean over sites, bootstrap 95% CI)",
        "",
        table.to_markdown(),
        "",
        "### Top-k overlap between σ variants (mean over sites)",
        "",
        sigma_pair_matrix(batch.e7_pairs).to_markdown(floatfmt=".3f"),
    ]
    scoring = scoring_table(batch.e7, k)
    if not scoring.empty:
        parts += [
            "",
            "### S against S_imp = S × importance(target) (L12; mean over sites, bootstrap 95% CI)",
            "",
            scoring.to_markdown(),
        ]
    for cls in style.ordered_classes(list(batch.e7["architecture_class"].unique())):
        parts += ["", f"#### {style.class_label(cls)}", "", ablation_table(batch.e7, k, scope=cls).to_markdown()]
    for sweep, metrics in [
        ("epsilon", ["topk_jaccard_default", f"e3_gain@{k}", "e6_mrr"]),
        ("alpha", ["topk_jaccard_default", f"e3_gain@{k}"]),
    ]:
        for metric in metrics:
            c = curve(batch.e7, sweep, metric)
            if c.empty:
                continue
            c.columns = [SIGMA_LABELS[s] for s in c.columns]
            parts += ["", f"### {METRIC_LABELS.get(metric.split('@')[0], metric)} across {sweep}", "", c.to_markdown(floatfmt=".4g")]
    return "\n".join(parts) + "\n"
