"""L13: metrics identical to E6's, site-grouped CV without leakage, predictions and SHAP."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("lightgbm")

from ml import data, metrics, model, report  # noqa: E402

NUMERIC = ["delta_pr", "ref", "cosine", "kappa", "same_section"]
CATEGORICAL = ["donor_type", "target_type"]
FEATURES = NUMERIC + CATEGORICAL
LGB = {"num_boost_round": 30, "learning_rate": 0.1, "num_leaves": 7, "min_data_in_leaf": 5,
       "feature_fraction": 1, "bagging_fraction": 1, "bagging_freq": 0, "lambda_l2": 1}


def _features(rng, n, positive):
    ref = rng.uniform(0, 0.3, n) + (0.4 if positive else 0)
    return {
        "delta_pr": rng.uniform(0, 1e-3, n),
        "ref": ref,
        "cosine": rng.uniform(0, 1, n),
        "kappa": rng.integers(1, 4, n).astype(float),
        "same_section": rng.integers(0, 2, n).astype(float),
        "donor_type": rng.choice(["article", "hub"], n),
        "target_type": rng.choice(["article", "product"], n),
    }


def write_site(root: Path, site: str, seed: int, queries: int = 25, candidates: int = 12) -> dict:
    rng = np.random.default_rng(seed)
    rows = []
    for q in range(queries):
        for c in range(candidates):
            f = _features(rng, 1, c == 0)
            rows.append({"repeat": 0, "query": f"0|t{q}|d0", "target": f"t{q}", "donor": f"d{c}",
                         "label": int(c == 0), "s_score": float(f["cosine"][0]) * 0.1,
                         "sigma_hybrid": float(f["cosine"][0]),
                         **{k: (v[0] if isinstance(v[0], str) else float(v[0])) for k, v in f.items()}})
    e6 = pd.DataFrame(rows)
    f = pd.DataFrame(_features(rng, 8, False))
    fixes = pd.concat([pd.DataFrame({"fix_id": [f"add-link:d{i}->t{i}" for i in range(8)], "donor": "d", "target": "t",
                                     "type": "add-link", "rank_s": range(1, 9), "s_score": 0.1}), f], axis=1)
    pool = pd.concat([pd.DataFrame({"entry_id": [f"p{i}" for i in range(8)], "donor": "d", "target": "t",
                                    "kind": "weak", "s_score": 0.1}), f], axis=1)
    ratings = pd.DataFrame(columns=["fix_id", "raters", "relevance", "s_score", *FEATURES])
    d = root / site
    d.mkdir(parents=True)
    sha = {}
    for name, df in [("e6.csv", e6), ("fixes.csv", fixes), ("pool.csv", pool), ("ratings.csv", ratings)]:
        df.to_csv(d / name, index=False)
        sha[name] = hashlib.sha256((d / name).read_bytes()).hexdigest()
    return {"site": site, "architectureClass": "cms-blog", "runId": seed, "sha256": sha}


@pytest.fixture
def dataset(tmp_path: Path) -> Path:
    root = tmp_path / "dataset"
    sites = [write_site(root, s, i + 1) for i, s in enumerate(["a", "b", "c"])]
    meta = {"version": "l13-dataset@1.0.0", "features": FEATURES, "numeric": NUMERIC, "categorical": CATEGORICAL,
            "lightgbm": LGB, "shapTop": 3, "ks": [5, 10], "e3Ks": [10], "seed": 42, "sites": sites}
    (root / "dataset.json").write_text(json.dumps(meta))
    return root


def test_metrics_match_e6_definitions():
    s = np.array([0.9, 0.5, 0.5, 0.1])
    r = metrics.rank_of(s, 1)
    assert (r.above, r.tied, r.candidates) == (1, 2, 4)
    assert metrics.recall_at(r, 2) == 0.5
    assert metrics.reciprocal_rank(r) == pytest.approx((1 / 2 + 1 / 3) / 2)
    assert metrics.auc(r) == pytest.approx((1 + 0.5) / 3)
    # All tied: random expectations (k/N, H_N/N, ½).
    flat = metrics.rank_of(np.zeros(4), 0)
    assert metrics.recall_at(flat, 1) == 0.25
    assert metrics.reciprocal_rank(flat) == pytest.approx((1 + 1 / 2 + 1 / 3 + 1 / 4) / 4)
    assert metrics.auc(flat) == 0.5


def test_query_metrics_requires_one_positive():
    e6 = pd.DataFrame({"query": ["q", "q"], "label": [1, 1]})
    with pytest.raises(ValueError):
        metrics.query_metrics(e6, np.array([1.0, 0.0]), [5])


def test_percentile_priority_is_in_unit_interval_and_monotone():
    p = metrics.percentile_priority(np.array([3.0, 1.0, 2.0, 2.0]))
    assert list(p) == [0.875, 0.125, 0.5, 0.5]
    assert metrics.percentile_priority(np.array([])).size == 0


def test_cross_validation_is_site_grouped_and_writes_predictions(dataset: Path, tmp_path: Path):
    ds = data.load(dataset)
    assert str(ds.sites[0].e6["donor_type"].dtype) == "category"
    out = tmp_path / "model"
    folds = model.cross_validate(ds, out)
    for f in folds:
        assert f.site.id not in f.trained_on and len(f.trained_on) == 2
        pred = json.loads((out / "predictions" / f"{f.site.id}.json").read_text())
        assert pred["runId"] == f.site.run_id and pred["dataset"] == ds.digest()
        assert set(pred["fixes"]) == set(f.site.fixes["fix_id"])
        for fx in pred["fixes"].values():
            assert 0 < fx["priority"] < 1
            assert len(fx["shap"]) == 3 and {"feature", "value", "contribution"} <= set(fx["shap"][0])
            assert all(c["feature"] in FEATURES for c in fx["shap"])
        assert len(pred["pool"]) == 8
        # The positive is separable by REF: the learned model recovers it far above chance.
        assert f.summary["learned"]["mrr"] > 0.8
    m = pd.read_csv(out / "e6_metrics.csv")
    assert set(m["method"]) == {"learned", "S", "hybrid"}
    assert model.rating_evaluation(ds, out) is None  # no ratings: no second label set


def test_training_is_deterministic(dataset: Path, tmp_path: Path):
    ds = data.load(dataset)
    model.cross_validate(ds, tmp_path / "m1")
    model.cross_validate(ds, tmp_path / "m2")
    a = json.loads((tmp_path / "m1" / "predictions" / "a.json").read_text())
    b = json.loads((tmp_path / "m2" / "predictions" / "a.json").read_text())
    assert a["fixes"] == b["fixes"]


def test_shap_contributions_sum_to_the_raw_score(dataset: Path):
    ds = data.load(dataset)
    booster = model.train(pd.concat([s.e6 for s in ds.sites[1:]]), ds)
    X = ds.sites[0].fixes[ds.features]
    full = booster.predict(X, pred_contrib=True)
    assert np.allclose(full.sum(axis=1), booster.predict(X))


def test_report_compares_learned_with_s(dataset: Path, tmp_path: Path):
    ds = data.load(dataset)
    out = tmp_path / "model"
    model.cross_validate(ds, out)
    pd.DataFrame(
        [{"site": s, "architecture_class": "cms-blog", "run_id": 1, "k": 10, "method": m, "totalDeltaPr": v,
          "selected": 10, "targetsCovered": 3}
         for s in "abc" for m, v in [("S", 0.01), ("learned", 0.012), ("random", 0.002)]]
    ).to_csv(out / "e3.csv", index=False)
    text = report.report(out, figures=False)
    assert "Learned vs S across sites (E6)" in text and "learned − S" in text
    assert "S remains the default" in text
    paired = report.e6_paired(pd.read_csv(out / "e6_metrics.csv"))
    assert "mrr" in paired.index and paired.loc["mrr", "sites"] == 3
