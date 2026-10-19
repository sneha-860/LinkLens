"""Deployable ranker (`python -m ml fit`) and the pipeline's scorer (`python -m ml score`)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("lightgbm")

from ml import data, deploy  # noqa: E402
from ml.__main__ import main  # noqa: E402
from test_ml import CATEGORICAL, FEATURES, LGB, NUMERIC, write_site  # noqa: E402


@pytest.fixture
def dataset(tmp_path: Path) -> Path:
    root = tmp_path / "dataset"
    sites = [{**write_site(root, s, i + 1), "url": f"https://www.{s}.test/"} for i, s in enumerate(["a", "b", "c"])]
    meta = {"version": "l13-dataset@1.0.0", "features": FEATURES, "numeric": NUMERIC, "categorical": CATEGORICAL,
            "lightgbm": LGB, "shapTop": 3, "ks": [5, 10], "e3Ks": [10], "seed": 42, "sites": sites}
    (root / "dataset.json").write_text(json.dumps(meta))
    return root


def _rows(n: int = 6) -> list[dict]:
    rng = np.random.default_rng(3)
    return [
        {"fix_id": f"add-link:d{i}->t", "donor": f"d{i}", "target": "t", "type": "add-link", "rank_s": i + 1,
         "s_score": 0.1, "delta_pr": float(rng.uniform(0, 1e-3)), "ref": 0.05 + 0.1 * i, "cosine": None,
         "kappa": 1.0, "same_section": 1.0, "donor_type": "article", "target_type": "product" if i % 2 else "nope"}
        for i in range(n)
    ]


def _request(rows: list[dict], features: list[str] = FEATURES) -> dict:
    return {"protocol": deploy.PROTOCOL, "kind": "ranker", "features": features, "shapTop": 2, "rows": rows}


def test_fit_writes_a_versioned_model_trained_on_every_site(dataset: Path, tmp_path: Path):
    out = tmp_path / "models"
    d = deploy.fit_ranker(data.load(dataset), out)
    meta = json.loads((d / "model.json").read_text(encoding="utf-8"))
    assert meta["trainedOn"] == ["a", "b", "c"]
    assert meta["trainedOnHosts"] == ["a.test", "b.test", "c.test"]
    assert meta["features"] == FEATURES and meta["format"] == deploy.RANKER_FORMAT
    files = deploy.model_files(d)
    assert [f["name"] for f in files] == ["model.json", "model.txt"]
    # The version of record is the hash the Node manifest computes the same way.
    expected = hashlib.sha256("".join(f"{f['name']}\0{f['sha256']}\n" for f in files).encode()).hexdigest()
    assert deploy.model_sha256(files) == expected
    # Deterministic: fitting again gives the same trees.
    again = deploy.fit_ranker(data.load(dataset), tmp_path / "again")
    assert (again / "model.txt").read_bytes() == (d / "model.txt").read_bytes()


def test_score_answers_the_pipeline_request(dataset: Path, tmp_path: Path):
    models = tmp_path / "models"
    deploy.fit_ranker(data.load(dataset), models)
    req = tmp_path / "request.json"
    req.write_text(json.dumps(_request(_rows())), encoding="utf-8")
    out = tmp_path / "response.json"
    assert main(["score", str(req), "--models", str(models), "--out", str(out)]) == 0
    r = json.loads(out.read_text(encoding="utf-8"))
    assert r["protocol"] == deploy.PROTOCOL and r["kind"] == "ranker"
    assert r["model"]["sha256"] == deploy.model_sha256(deploy.model_files(models / "ranker"))
    assert r["model"]["trainedOnHosts"] == ["a.test", "b.test", "c.test"]
    fixes = r["fixes"]
    assert sorted(fixes) == sorted(x["fix_id"] for x in _rows())
    priorities = sorted(f["priority"] for f in fixes.values())
    assert all(0 < p < 1 for p in priorities)
    for f in fixes.values():
        assert len(f["shap"]) == 2
        assert all(set(c) == {"feature", "value", "contribution"} for c in f["shap"])
    # A higher REF (the planted signal) ranks higher.
    raw = [fixes[f"add-link:d{i}->t"]["raw"] for i in range(6)]
    assert raw[-1] > raw[0]


def test_score_refuses_a_mismatched_request(dataset: Path, tmp_path: Path):
    models = tmp_path / "models"
    deploy.fit_ranker(data.load(dataset), models)
    with pytest.raises(ValueError, match="lacks the model's features"):
        deploy.score_ranker(_request(_rows(), FEATURES[:-1]), models)
    req = tmp_path / "bad.json"
    req.write_text(json.dumps({**_request(_rows()), "protocol": "other@9"}), encoding="utf-8")
    with pytest.raises(ValueError, match="unknown protocol"):
        deploy.score(req, models, tmp_path / "out.json")


def test_score_without_a_model_says_how_to_fit_one(tmp_path: Path):
    with pytest.raises(FileNotFoundError, match="no ranker model .*python -m ml fit"):
        deploy.score_ranker(_request(_rows()), tmp_path)


def test_fit_refuses_the_graphsage_feature(dataset: Path, tmp_path: Path):
    ds = data.load(dataset)
    ds.meta["features"] = [*ds.meta["features"], "graphsage"]
    with pytest.raises(ValueError, match="graphsage feature"):
        deploy.fit_ranker(ds, tmp_path)
