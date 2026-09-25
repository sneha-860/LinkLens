"""Load LinkLens evaluation results (the JSON written by `pnpm --filter @linklens/eval e … --out`)
and turn them into tables and tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats

from . import RANDOM_SEED


def load(path: str | Path) -> dict[str, Any]:
    """One result file: {"experiment": "E3", "artefactId": …, "result": {…}}."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if "experiment" not in data or "result" not in data:
        raise ValueError(f"{path}: not a LinkLens evaluation result")
    return data


# ---------- tables ----------


def e1_table(result: dict[str, Any]) -> pd.DataFrame:
    """E1: one row per policy."""
    cols = [
        "policy",
        "nodes",
        "orphans",
        "issues",
        "topFixesJaccard",
        "pagerankSpearman",
        "meanDepthShift",
        "meanAbsDepthShift",
    ]
    return pd.DataFrame(result["policies"])[cols].set_index("policy")


def e2_table(result: dict[str, Any]) -> pd.DataFrame:
    """E2: each channel alone and what dropping it costs."""
    single = {tuple(r["channels"])[0]: r["orphansFound"] for r in result["single"]}
    rows = [
        {
            "channel": r["removed"],
            "orphans alone": single.get(r["removed"], 0),
            "orphans lost without it": r["orphansLost"],
            "recall without it": r["orphanRecall"],
        }
        for r in result["leaveOneOut"]
    ]
    return pd.DataFrame(rows).set_index("channel")


def e3_table(result: dict[str, Any]) -> pd.DataFrame:
    """E3: one row per method (LinkLens, the baselines, the oracle)."""
    return pd.DataFrame(result["methods"]).set_index("method")


def e3_paired_tests(result: dict[str, Any]) -> pd.DataFrame:
    """E3: LinkLens against each baseline on the same targets, paired Wilcoxon signed-rank on ΔPR."""
    rows = []
    per = result.get("perTarget", [])
    methods = [m["method"] for m in result["methods"] if m["method"] != "linklens"]
    for method in methods:
        pairs = [
            (t["picks"]["linklens"]["deltaPr"], t["picks"][method]["deltaPr"])
            for t in per
            if "linklens" in t["picks"] and method in t["picks"]
        ]
        ours = np.array([p[0] for p in pairs])
        theirs = np.array([p[1] for p in pairs])
        diff = ours - theirs
        nonzero = diff[diff != 0]
        p = float(stats.wilcoxon(nonzero).pvalue) if len(nonzero) >= 1 else float("nan")
        rows.append(
            {
                "baseline": method,
                "targets": len(pairs),
                "median ΔPR difference": float(np.median(diff)) if len(diff) else float("nan"),
                "LinkLens better": int((diff > 0).sum()),
                "baseline better": int((diff < 0).sum()),
                "wilcoxon p": p,
            }
        )
    return pd.DataFrame(rows).set_index("baseline")


def bootstrap_ci(
    values: np.ndarray, statistic=np.mean, n: int = 2000, level: float = 0.95, seed: int = RANDOM_SEED
) -> tuple[float, float]:
    """Percentile bootstrap confidence interval (seeded: the same data gives the same interval)."""
    if len(values) == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    samples = rng.choice(values, size=(n, len(values)), replace=True)
    stat = np.apply_along_axis(statistic, 1, samples)
    lo, hi = np.quantile(stat, [(1 - level) / 2, 1 - (1 - level) / 2])
    return (float(lo), float(hi))


def recovery_table(result: dict[str, Any]) -> pd.DataFrame:
    """E6/E7: MRR (with a bootstrap 95% CI over the hidden links) and recall@k per σ."""
    rows = []
    for sigma, m in result["bySigma"].items():
        rr = np.array([0.0 if r is None else 1.0 / r for r in m["ranks"]])
        lo, hi = bootstrap_ci(rr)
        row = {"sigma": sigma, "hidden": len(rr), "MRR": m["mrr"], "MRR 95% CI": f"[{lo:.3f}, {hi:.3f}]"}
        for k, v in m["recall"].items():
            row[f"recall@{k}"] = v
        rows.append(row)
    return pd.DataFrame(rows).set_index("sigma")


def sigma_paired_tests(result: dict[str, Any]) -> pd.DataFrame:
    """E7: each pair of σ variants on the same hidden links, Wilcoxon on reciprocal ranks."""
    rr = {
        s: np.array([0.0 if r is None else 1.0 / r for r in m["ranks"]])
        for s, m in result["bySigma"].items()
    }
    names = sorted(rr)
    rows = []
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            diff = rr[a] - rr[b]
            nonzero = diff[diff != 0]
            rows.append(
                {
                    "a": a,
                    "b": b,
                    "mean RR difference": float(diff.mean()) if len(diff) else float("nan"),
                    "wilcoxon p": float(stats.wilcoxon(nonzero).pvalue) if len(nonzero) >= 1 else float("nan"),
                }
            )
    return pd.DataFrame(rows)


def summary_series(result: dict[str, Any], keys: list[str]) -> pd.Series:
    """E4 / E5 / E8: the headline numbers as one column."""
    flat: dict[str, Any] = {}
    for k in keys:
        v = result.get(k)
        if isinstance(v, dict):
            for kk, vv in v.items():
                flat[f"{k}.{kk}"] = vv
        else:
            flat[k] = v
    return pd.Series(flat)


TABLES = {
    "E1": lambda r: [("Policies", e1_table(r))],
    "E2": lambda r: [("Channels", e2_table(r))],
    "E3": lambda r: [("Methods", e3_table(r)), ("LinkLens vs baselines (paired)", e3_paired_tests(r))],
    "E4": lambda r: [
        (
            "Stability",
            summary_series(
                r,
                [
                    "daysApart",
                    "pagesJaccard",
                    "edgesJaccard",
                    "orphansJaccard",
                    "pagerankSpearman",
                    "meanAbsDepthShift",
                    "topFixesJaccard",
                    "caseAgreement",
                ],
            ).to_frame("value"),
        )
    ],
    "E5": lambda r: [
        ("Calibration", summary_series(r, ["ours", "screamingFrog", "common", "coverageJaccard", "depth", "inlinksSpearman"]).to_frame("value"))
    ],
    "E6": lambda r: [("Hide-and-recover", recovery_table(r))],
    "E7": lambda r: [("σ ablation", recovery_table(r)), ("σ pairs", sigma_paired_tests(r))],
    "E8": lambda r: [
        (
            "Ratings",
            summary_series(
                r,
                ["ratings", "items", "meanRelevance", "wouldAddRate", "meanRelevanceTop10", "meanRelevanceRest", "scoreVsRelevance", "interRater"],
            ).to_frame("value"),
        )
        if "ratings" in r
        else ("Ratings", pd.DataFrame({"note": ["rating sheet only: fill it in, then run E8 --ratings"]}))
    ],
}


def tables(data: dict[str, Any]) -> list[tuple[str, pd.DataFrame]]:
    return TABLES[data["experiment"]](data["result"])


def report(paths: list[str]) -> str:
    """Markdown tables for result files (in the order given)."""
    out: list[str] = []
    for p in paths:
        data = load(p)
        out.append(f"## {data['experiment']} ({Path(p).name})\n")
        for title, df in tables(data):
            out.append(f"### {title}\n\n{df.to_markdown()}\n")
    return "\n".join(out)
