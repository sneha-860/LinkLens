"""LightGBM lambdarank with site-grouped cross-validation (leave one site out), and TreeSHAP.

Every site's predictions come from a model trained on the other sites only, so nothing about a
site (its pages, its links, its labels) reaches the model that scores it. Queries are E6 masked
links: one positive (the hidden donor) among the target's candidates.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .data import Dataset, Site
from .metrics import percentile_priority, query_metrics, summarise

SHAP_SAMPLE = 2000  # E6 rows per held-out site kept for the global SHAP summary (seeded)


def lgb_params(meta: dict) -> tuple[dict, int]:
    """LightGBM parameters from the run config (l13Lightgbm), made deterministic."""
    p = dict(meta["lightgbm"])
    rounds = int(p.pop("num_boost_round", 300))
    for k in ("num_leaves", "min_data_in_leaf", "bagging_freq"):
        if k in p:
            p[k] = int(p[k])
    params = {
        "objective": "lambdarank",
        "metric": "ndcg",
        "verbose": -1,
        "seed": int(meta["seed"]),
        "deterministic": True,
        "force_row_wise": True,
        "num_threads": 1,
        **p,
    }
    return params, rounds


def _sorted(e6: pd.DataFrame) -> pd.DataFrame:
    """Rows grouped by query (contiguous, as lambdarank needs), in a fixed order."""
    return e6.sort_values(["query", "donor"], kind="mergesort").reset_index(drop=True)


def train(e6: pd.DataFrame, ds: Dataset):
    import lightgbm as lgb

    params, rounds = lgb_params(ds.meta)
    d = _sorted(e6)
    groups = d.groupby("query", sort=False).size().to_numpy()
    data = lgb.Dataset(
        d[ds.features],
        label=d["label"].to_numpy(),
        group=groups,
        categorical_feature=ds.categorical,
        free_raw_data=False,
    )
    return lgb.train(params, data, num_boost_round=rounds)


def contributions(booster, X: pd.DataFrame) -> np.ndarray:
    """Exact TreeSHAP values per feature (LightGBM pred_contrib), the bias column dropped."""
    if len(X) == 0:
        return np.zeros((0, X.shape[1]))
    return np.asarray(booster.predict(X, pred_contrib=True))[:, :-1]


def top_contributions(X: pd.DataFrame, shap: np.ndarray, features: list[str], top: int) -> list[list[dict]]:
    """Per row, the `top` largest |SHAP| contributions with the feature's value."""
    out = []
    for i in range(len(X)):
        order = np.argsort(-np.abs(shap[i]), kind="mergesort")[:top]
        row = []
        for j in order:
            v = X.iloc[i][features[j]]
            value = None if (isinstance(v, float) and np.isnan(v)) else (v if isinstance(v, str) else float(v))
            row.append({"feature": features[j], "value": value, "contribution": float(shap[i, j])})
        out.append(row)
    return out


@dataclass
class FoldResult:
    site: Site
    trained_on: list[str]
    per_query: dict[str, pd.DataFrame]
    summary: dict[str, dict[str, float]]
    shap_sample: pd.DataFrame


def _json_value(v):
    return None if isinstance(v, float) and np.isnan(v) else v


def cross_validate(ds: Dataset, out: str | Path) -> list[FoldResult]:
    """Leave-one-site-out: train on every other site's E6 rows, then for the held-out site score
    its E6 queries (learned vs S vs the hybrid σ), its fixes and its E3 pool, with SHAP.
    Writes predictions/<site>.json, e6_metrics.csv, e6_queries.csv, shap_sample.csv, model.json."""
    out = Path(out)
    (out / "predictions").mkdir(parents=True, exist_ok=True)
    ks = [int(k) for k in ds.meta["ks"]]
    top = int(ds.meta["shapTop"])
    labelled = [s for s in ds.sites if s.e6["query"].nunique() > 0]
    if len(labelled) < 2:
        raise ValueError("site-grouped cross-validation needs E6 labels on at least two sites")
    params, rounds = lgb_params(ds.meta)
    digest = ds.digest()
    created = datetime.now(timezone.utc).isoformat()
    rng = np.random.default_rng(int(ds.meta["seed"]))
    folds: list[FoldResult] = []
    metric_rows, query_rows, shap_rows = [], [], []

    for site in ds.sites:
        train_sites = [s for s in labelled if s.id != site.id]
        booster = train(pd.concat([s.e6 for s in train_sites], ignore_index=True), ds)
        per_query: dict[str, pd.DataFrame] = {}
        summary: dict[str, dict[str, float]] = {}
        shap_sample = pd.DataFrame()
        if site in labelled:
            e6 = _sorted(site.e6)
            raw = np.asarray(booster.predict(e6[ds.features]))
            for method, score in [("learned", raw), ("S", e6["s_score"].to_numpy()), ("hybrid", e6["sigma_hybrid"].to_numpy())]:
                pq = query_metrics(e6, np.asarray(score, dtype=float), ks)
                per_query[method] = pq
                summary[method] = summarise(pq, ks)
                for m, v in summary[method].items():
                    metric_rows.append({"site": site.id, "architecture_class": site.architecture_class, "method": method, "metric": m, "value": v})
                query_rows.append(pq.assign(site=site.id, architecture_class=site.architecture_class, method=method))
            take = rng.choice(len(e6), size=min(SHAP_SAMPLE, len(e6)), replace=False)
            take.sort()
            X = e6.iloc[take][ds.features]
            sv = contributions(booster, X)
            shap_sample = pd.DataFrame(sv, columns=ds.features).assign(site=site.id)
            values = X.reset_index(drop=True).add_prefix("value__")
            shap_rows.append(pd.concat([shap_sample.reset_index(drop=True), values], axis=1))

        fixes_raw = np.asarray(booster.predict(site.fixes[ds.features])) if len(site.fixes) else np.zeros(0)
        fixes_shap = contributions(booster, site.fixes[ds.features])
        tops = top_contributions(site.fixes[ds.features], fixes_shap, ds.features, top)
        pool_raw = np.asarray(booster.predict(site.pool[ds.features])) if len(site.pool) else np.zeros(0)
        prediction = {
            "site": site.id,
            "runId": site.run_id,
            "trainedOn": [s.id for s in train_sites],
            "labels": "e6",
            "features": ds.features,
            "params": {**{k: v for k, v in params.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}, "num_boost_round": rounds},
            "dataset": digest,
            "createdAt": created,
            "fixes": {
                fid: {"priority": float(p), "raw": float(r), "shap": [{k: _json_value(v) for k, v in c.items()} for c in t]}
                for fid, p, r, t in zip(site.fixes["fix_id"], percentile_priority(fixes_raw), fixes_raw, tops)
            },
            "pool": {
                eid: {"priority": float(p), "raw": float(r)}
                for eid, p, r in zip(site.pool["entry_id"], percentile_priority(pool_raw), pool_raw)
            },
        }
        (out / "predictions" / f"{site.id}.json").write_text(json.dumps(prediction, indent=1) + "\n", encoding="utf-8")
        folds.append(FoldResult(site, prediction["trainedOn"], per_query, summary, shap_sample))

    pd.DataFrame(metric_rows).to_csv(out / "e6_metrics.csv", index=False, lineterminator="\n")
    if query_rows:
        pd.concat(query_rows, ignore_index=True).to_csv(out / "e6_queries.csv", index=False, lineterminator="\n")
    if shap_rows:
        pd.concat(shap_rows, ignore_index=True).to_csv(out / "shap_sample.csv", index=False, lineterminator="\n")
    (out / "model.json").write_text(
        json.dumps(
            {
                "dataset": digest,
                "datasetDir": str(ds.directory),
                "createdAt": created,
                "cv": "leave-one-site-out",
                "sites": [{"site": f.site.id, "class": f.site.architecture_class, "trainedOn": f.trained_on} for f in folds],
                "params": params,
                "num_boost_round": rounds,
                "features": ds.features,
                "categorical": ds.categorical,
                "ks": ks,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    return folds


def rating_evaluation(ds: Dataset, out: str | Path) -> pd.DataFrame | None:
    """E8 as a second label set, when at least two sites have rated fixes: leave one rated site
    out, train on the others' ratings (graded 0/1/2 from the raters' mean relevance, grouped by
    site) and compare the held-out ranking with S by NDCG@10 and precision@10. None otherwise."""
    import lightgbm as lgb

    rated = [s for s in ds.sites if len(s.ratings) > 0]
    if len(rated) < 2:
        return None
    params, rounds = lgb_params(ds.meta)
    rows = []
    for site in rated:
        train_sites = [s for s in rated if s.id != site.id]
        tr = pd.concat([s.ratings.assign(_site=s.id) for s in train_sites], ignore_index=True).sort_values("_site", kind="mergesort")
        grade = np.rint(tr["relevance"].to_numpy() * 2).astype(int)
        data = lgb.Dataset(tr[ds.features], label=grade, group=tr.groupby("_site", sort=False).size().to_numpy(), categorical_feature=ds.categorical)
        booster = lgb.train({**params, "min_data_in_leaf": 1}, data, num_boost_round=rounds)
        held = site.ratings
        rel = held["relevance"].to_numpy()
        for method, score in [("learned", booster.predict(held[ds.features])), ("S", held["s_score"].to_numpy())]:
            order = np.argsort(-np.asarray(score, dtype=float), kind="mergesort")
            k = min(10, len(order))
            gains = rel[order][:k]
            dcg = float(np.sum(gains / np.log2(np.arange(2, k + 2))))
            ideal = np.sort(rel)[::-1][:k]
            idcg = float(np.sum(ideal / np.log2(np.arange(2, k + 2))))
            rows.append({"site": site.id, "method": method, "ndcg@10": dcg / idcg if idcg > 0 else np.nan, "precision@10": float(np.mean(gains >= 0.5))})
    df = pd.DataFrame(rows)
    df.to_csv(Path(out) / "e8_ratings.csv", index=False, lineterminator="\n")
    return df
