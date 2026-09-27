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


def e1_pairs_table(result: dict[str, Any]) -> pd.DataFrame:
    """E1: every pair of policies (a before b; signed values are b − a)."""
    cols = [
        "nodesA",
        "nodesB",
        "orphanJaccard",
        "pagerankSpearman",
        "meanDepthShift",
        "maxAbsDepthShift",
        "topFixesJaccard",
    ]
    df = pd.DataFrame(result["pairs"])
    df.index = df["a"] + "–" + df["b"]
    df.index.name = "pair"
    return df[cols]


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


def e2_removals_table(result: dict[str, Any]) -> pd.DataFrame:
    """E2: each of the six channels removed and the reconciliation recomputed."""
    cols = [
        "pagesTotal",
        "pagesExclusive",
        "orphansTotal",
        "orphansExclusive",
        "orphansExclusiveShare",
        "inventoryWithout",
        "orphansWithout",
    ]
    return pd.DataFrame(result["removals"]).set_index("channel")[cols]


def e4_pages_table(result: dict[str, Any]) -> pd.DataFrame:
    """E4 on one site: the pages of the two crawls by class and cause."""
    p = result["pages"]
    rows = {
        "days apart": result["daysApart"],
        "pages (union)": p["union"],
        "unchanged": p["unchanged"],
        "changed (site)": p["changed"],
        **{f"only one run, site: {k}": v for k, v in p["site"].items()},
        **{f"only one run, crawl: {k}": v for k, v in p["method"].items()},
        "site change share": result["siteChangeShare"],
        "crawl instability share": result["methodShare"],
    }
    return pd.Series(rows).to_frame("value")


def e4_comparisons_table(result: dict[str, Any]) -> pd.DataFrame:
    """E4 on one site: each comparison (observed, site change, same pages, coverage)."""
    cols = ["nodeJaccard", "pagerankSpearman", "orphanJaccard", "topFixesJaccard", "crawledA", "crawledB"]
    df = pd.DataFrame(result["comparisons"]).T[cols]
    df.index.name = "comparison"
    return df


def e5_table(result: dict[str, Any]) -> pd.DataFrame:
    """E5 on one site: LinkLens against Screaming Frog under each policy."""
    rows = []
    for p in result["policies"]:
        rows.append(
            {
                "policy": p["policy"],
                "URLs LinkLens": p["urls"]["linklens"],
                "URLs Screaming Frog": p["urls"]["screamingFrog"],
                "URL Jaccard": p["urls"]["jaccard"],
                "inlinks Spearman": p["inlinks"]["spearman"],
                "inlinks Spearman (SF column)": p["inlinks"]["spearmanColumn"],
                "depth exact": p["depth"]["exact"],
                "depth ±1": p["depth"]["withinOne"],
                "depth Spearman": p["depth"]["spearman"],
                "orphan Jaccard": p["orphans"]["jaccard"],
            }
        )
    return pd.DataFrame(rows).set_index("policy")


def e5_categories_table(result: dict[str, Any]) -> pd.DataFrame:
    """E5 on one site: every disagreement category with its explanation."""
    rows = [
        {"policy": p["policy"], **{k: c[k] for k in ("kind", "category", "count", "share", "large", "explanation")}}
        for p in result["policies"]
        for c in p["categories"]
    ]
    cols = ["policy", "kind", "category", "count", "share", "large", "explanation"]
    return pd.DataFrame(rows, columns=cols).set_index(["policy", "kind", "category"])


def e6_table(result: dict[str, Any]) -> pd.DataFrame:
    """E6 on one site: each method's metrics averaged over the repeats."""
    ks = result["options"]["ks"]
    rows = []
    for method, m in result["summary"].items():
        row = {"method": method, "queries": m["queries"], "MRR": m["mrr"], "AUC": m["auc"]}
        for k in ks:
            row[f"R@{k}"] = m["recall"][str(k)]
        rows.append(row)
    return pd.DataFrame(rows).set_index("method")


def e6_repeats_table(result: dict[str, Any]) -> pd.DataFrame:
    """E6 on one site: each repeat's masking."""
    cols = ["repeat", "seed", "share", "eligiblePairs", "masked", "targets", "queries"]
    return pd.DataFrame(result["repeats"])[cols].set_index("repeat")


def e3_table(result: dict[str, Any]) -> pd.DataFrame:
    """E3 on one run: each k × method, the top-k fixes applied together (total ΔPR over the
    weak-authority and orphan pages). Paired tests across sites: e3.py on a corpus batch."""
    rows = [
        {
            "k": b["k"],
            "method": m["method"],
            "selected": m["selected"],
            "targets covered": m["targetsCovered"],
            "total ΔPR": m["totalDeltaPr"],
            "total ΔPR sd": m["totalDeltaPrSd"],
            "Σ single ΔPR": m["sumSingleDeltaPr"],
            "newly reachable": m["newlyReachable"],
            "mean REF": m["meanRef"],
            "mean cosine": m["meanCosine"],
        }
        for b in result["byK"]
        for m in b["methods"]
    ]
    return pd.DataFrame(rows).set_index(["k", "method"])


def e3_pool_table(result: dict[str, Any]) -> pd.DataFrame:
    """E3 on one run: the targets and the admissible pool."""
    t, p = result["targets"], result["pool"]
    return pd.Series(
        {
            "weak-authority pages": t["weak"],
            "orphans": t["orphan"],
            "admissible fixes": p["pairs"],
            "weak pages with a donor": p["weakTargetsWithDonors"],
            "orphans with a donor": p["orphanTargetsWithDonors"],
            "Σ PR of the targets before": result["targetPagerankBefore"],
        }
    ).to_frame("value")


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
    "E1": lambda r: [("Policies", e1_table(r))]
    + ([("Policy pairs", e1_pairs_table(r))] if r.get("pairs") else []),
    "E2": lambda r: [("Channels", e2_table(r))]
    + ([("Each channel removed", e2_removals_table(r))] if r.get("removals") else []),
    "E3": lambda r: [("Targets and pool", e3_pool_table(r)), ("Top-k fixes applied together", e3_table(r))],
    "E4": lambda r: [("Pages", e4_pages_table(r)), ("Comparisons", e4_comparisons_table(r))],
    "E5": lambda r: [("Calibration", e5_table(r)), ("Disagreement categories", e5_categories_table(r))],
    "E6": lambda r: [("Link-masking recovery", e6_table(r)), ("Repeats", e6_repeats_table(r))],
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
