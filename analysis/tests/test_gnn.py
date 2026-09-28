"""GraphSAGE (ml.gnn): the export format, site-grouped training, E6 metrics, the ranker feature."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("torch")
pytest.importorskip("torch_geometric")

from ml import gnn, gnn_report, metrics  # noqa: E402

EMB = 8
STRUCT = 6
PARAMS = {"layers": 2, "hidden": 16, "epochs": 40, "learning_rate": 0.02, "weight_decay": 0.0,
          "dropout": 0.0, "negative_ratio": 1, "supervision_share": 0.3}


def _write_graph(d: Path, name: str, nodes: list[str], x: np.ndarray, edges: list[tuple[int, int]], sha: dict):
    files = {
        f"{name}.nodes.txt": "".join(f"{n}\n" for n in nodes).encode(),
        f"{name}.x.f32": x.astype("<f4").tobytes(),
        f"{name}.edges.csv": ("src,dst\r\n" + "".join(f"{u},{v}\r\n" for u, v in edges)).encode(),
    }
    for f, b in files.items():
        (d / f).write_bytes(b)
        sha[f] = hashlib.sha256(b).hexdigest()


def write_site(root: Path, site: str, seed: int, n: int = 30, clusters: int = 3, repeats: int = 2) -> dict:
    """Pages in topic clusters (embedding = cluster direction + noise); links within a cluster."""
    rng = np.random.default_rng(seed)
    nodes = [f"https://{site}.test/p{i:02d}" for i in range(n)]
    cl = np.arange(n) % clusters
    emb = np.eye(clusters, EMB)[cl] + rng.normal(0, 0.2, (n, EMB))
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    x = np.hstack([emb, rng.normal(0, 1, (n, STRUCT))]).astype(np.float32)
    edges = [(u, v) for u in range(n) for v in range(n) if u != v and cl[u] == cl[v] and rng.random() < 0.5]
    d = root / site
    d.mkdir(parents=True)
    sha: dict = {}
    _write_graph(d, "full", nodes, x, edges, sha)
    graphs = [{"name": "full", "repeat": None, "seed": None, "nodes": n, "edges": len(edges), "queries": 0, "pairs": 0}]
    for r in range(repeats):
        rr = np.random.default_rng(seed * 100 + r)
        masked = [edges[i] for i in rr.choice(len(edges), size=max(3, len(edges) // 8), replace=False)]
        kept = [e for e in edges if e not in masked]
        name = f"r{r}"
        _write_graph(d, name, nodes, x, kept, sha)
        q = pd.DataFrame([{"target": nodes[v], "donor": nodes[u]} for u, v in masked])
        linked = {(u, v) for u, v in kept}
        pairs = []
        for v in sorted({v for _, v in masked}):
            for u in range(n):
                if u != v and (u, v) not in linked:
                    cos = float(emb[u] @ emb[v])
                    pairs.append({"target": nodes[v], "donor": nodes[u], "ref": max(0.0, cos), "cosine": cos,
                                  "hybrid": cos if cos > 0.2 else 0.0})
        q.to_csv(d / f"{name}.queries.csv", index=False)
        pd.DataFrame(pairs).to_csv(d / f"{name}.pairs.csv", index=False)
        graphs.append({"name": name, "repeat": r, "seed": 42 + r, "nodes": n, "edges": len(kept),
                       "queries": len(q), "pairs": len(pairs)})
    return {"site": site, "architectureClass": "cms-blog", "runId": seed, "exportMs": 10.0,
            "embeddingDim": EMB, "width": EMB + STRUCT, "graphs": graphs, "sha256": sha}


@pytest.fixture
def graphs(tmp_path: Path) -> Path:
    root = tmp_path / "graphs"
    sites = [write_site(root, s, i + 1) for i, s in enumerate(["a", "b", "c"])]
    meta = {"version": "l13-graphs@1.0.0", "graphsage": PARAMS, "ks": [5, 10], "seed": 42,
            "e6Repeats": 2, "sites": sites}
    (root / "graphs.json").write_text(json.dumps(meta))
    return root


def test_load_reads_the_export_format(graphs: Path):
    gs = gnn.load(graphs)
    s = gs.sites[0]
    assert s.full.x.shape == (30, EMB + STRUCT) and s.full.x.dtype == np.float32
    assert [g.repeat for g in s.repeats] == [0, 1]
    assert s.repeats[0].edges.shape[0] == 2 and len(s.repeats[0].queries) > 0


def test_e6_rows_follow_e6_candidates(graphs: Path):
    g = gnn.load(graphs).sites[0].repeats[0]
    rows = gnn.e6_rows(g, np.zeros(len(g.pairs)))
    for q, grp in rows.groupby("query"):
        assert grp["label"].sum() == 1
        target, donor = q.split("|")[1:]
        others = set(g.queries[g.queries["target"] == target]["donor"]) - {donor}
        assert not set(grp["donor"]) & others  # the target's other masked donors are left out
    # All-zero scores are the random baseline: AUC exactly ½ per query.
    pq = metrics.query_metrics(rows, rows["graphsage"].to_numpy(), [5])
    assert np.allclose(pq["auc"], 0.5)


def test_cross_validation_is_site_grouped_and_learns_the_clusters(graphs: Path, tmp_path: Path):
    gs = gnn.load(graphs)
    out = tmp_path / "gnn"
    m = gnn.cross_validate(gs, out)
    means = gnn.site_means(m).set_index(["site", "method"])
    for s in "abc":
        pred = json.loads((out / "predictions" / f"{s}.json").read_text())
        assert s not in pred["model"]["trainedOn"] and len(pred["model"]["trainedOn"]) == 2
        assert set(pred["model"]["runtimeMs"]) == {"export", "train", "score"}
        assert [r["seed"] for r in pred["repeats"]] == [42, 43]
        # Links follow the clusters, which only the features reveal: well above random (½).
        assert means.loc[(s, "graphsage"), "auc"] > 0.75
    rt = pd.read_csv(out / "runtime.csv")
    assert list(rt["site"]) == ["a", "b", "c"] and (rt["train_ms"] > 0).all()
    assert set(m["method"]) == set(gnn.METHODS)


def test_training_is_deterministic(graphs: Path, tmp_path: Path):
    gs = gnn.load(graphs)
    gnn.cross_validate(gs, tmp_path / "g1")
    gnn.cross_validate(gs, tmp_path / "g2")
    a = json.loads((tmp_path / "g1" / "predictions" / "a.json").read_text())
    b = json.loads((tmp_path / "g2" / "predictions" / "a.json").read_text())
    assert a["repeats"] == b["repeats"]


def test_scores_are_directed_and_unknown_pairs_are_nan(graphs: Path):
    gs = gnn.load(graphs)
    s = gs.sites[0]
    model, scaler = gnn.train([g for o in gs.sites[1:] for g in o.repeats], gs.meta, EMB, 42)
    u, v = s.full.nodes[0], s.full.nodes[3]
    fwd, back, missing = gnn.score_pairs(model, scaler, s.full, [u, v, "https://x.test/"], [v, u, u])
    assert fwd != back
    assert np.isnan(missing)


def test_attach_scores_and_report(graphs: Path, tmp_path: Path):
    gs = gnn.load(graphs)
    out = tmp_path / "gnn"
    gnn.cross_validate(gs, out)
    scores = pd.read_csv(out / "scores" / "a" / "e6.csv", dtype={"target": str, "donor": str})
    rows = scores.head(3)[["repeat", "target", "donor"]].assign(label=0)
    joined = gnn.attach_scores(rows, out / "scores", "a", "e6")
    assert np.allclose(joined["graphsage"], scores.head(3)["score"])
    # No scores file: NaN, never an error.
    fx = gnn.attach_scores(pd.DataFrame({"fix_id": ["f"]}), out / "scores", "a", "fixes")
    assert fx["graphsage"].isna().all()
    text = gnn_report.report(out)
    assert "GraphSAGE vs REF, cosine and the hybrid" in text and "Runtime" in text
    assert "off by default" in text


def test_a_site_without_pages_is_skipped(graphs: Path, tmp_path: Path):
    meta = json.loads((graphs / "graphs.json").read_text())
    d = graphs / "empty"
    d.mkdir()
    sha: dict = {}
    _write_graph(d, "full", [], np.zeros((0, STRUCT), dtype=np.float32), [], sha)
    meta["sites"].append({"site": "empty", "architectureClass": "documentation", "runId": 99, "exportMs": 1.0,
                          "embeddingDim": 0, "width": STRUCT, "sha256": sha,
                          "graphs": [{"name": "full", "repeat": None, "seed": None, "nodes": 0, "edges": 0,
                                      "queries": 0, "pairs": 0}]})
    (graphs / "graphs.json").write_text(json.dumps(meta))
    gs = gnn.load(graphs)
    gs.meta["graphsage"] = {**PARAMS, "epochs": 5}
    out = tmp_path / "gnn"
    gnn.cross_validate(gs, out)
    assert not (out / "predictions" / "empty.json").exists()
    assert "empty" not in json.loads((out / "predictions" / "a.json").read_text())["model"]["trainedOn"]


def test_fast_e6_metrics_equal_the_table_path(graphs: Path):
    g = gnn.load(graphs).sites[1].repeats[1]
    scores = np.random.default_rng(3).normal(size=len(g.pairs)).round(1)  # ties included
    scores[::7] = np.nan  # unscored pairs rank last
    fast = gnn.e6_query_metrics(g, scores, [5, 10])
    rows = gnn.e6_rows(g, scores)
    rows["graphsage"] = rows["graphsage"].fillna(-np.inf)
    for m in gnn.METHODS:
        slow = metrics.query_metrics(rows, rows[m].to_numpy(dtype=float), [5, 10])
        pd.testing.assert_frame_equal(
            fast[m].sort_values("query").reset_index(drop=True),
            slow.sort_values("query").reset_index(drop=True),
            check_like=True,
        )
