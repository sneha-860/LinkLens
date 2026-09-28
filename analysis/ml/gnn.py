"""GraphSAGE link predictor (optional; PyTorch Geometric, `pip install -e ".[gnn]"`).

Inputs are the graphs `l13 graph-export` writes (packages/eval/src/l13/graph.ts): per site the
unmasked graph and each of E6's masked repeats, over the pages with text, with body-region edges
and node features (the page embedding, then PageRank × N, 1/(1+depth), reachable, log degrees and
importance).

Training is leave-one-site-out, like the L13 ranker: a site's scores come from a model trained on
the other sites' masked repeat graphs only. Masked links are not edges of those graphs, so they
never enter training; the held-out site is never seen. Each epoch, every training graph's edges
are split at random into message-passing edges and supervision edges (`supervision_share`), and
`negative_ratio` non-edges per supervision edge are sampled; the loss is binary cross-entropy.

Model: `layers` SAGEConv layers with the mean aggregator over the undirected body graph, then a
directed decoder, an MLP over [z_u, z_v], so score(u→v) ≠ score(v→u). The structural features are
standardised with the training graphs' mean and standard deviation (per fold).

Scores are logits (higher = more likely u links to v). E6 is evaluated here exactly as E6
does it: per query, the target's candidates minus its other masked donors; expected metrics under
random tie-breaking (ml.metrics); per site, the mean over repeats.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .metrics import query_metrics, summarise

METHODS = ["graphsage", "hybrid", "cosine", "ref"]


@dataclass(eq=False)
class Graph:
    name: str
    nodes: list[str]
    x: np.ndarray  # N × width, float32
    edges: np.ndarray  # 2 × E, int64 (src, dst)
    repeat: int | None = None
    seed: int | None = None
    queries: pd.DataFrame | None = None
    pairs: pd.DataFrame | None = None

    @property
    def index(self) -> dict[str, int]:
        return {n: i for i, n in enumerate(self.nodes)}


@dataclass(eq=False)
class SiteGraphs:
    id: str
    architecture_class: str
    run_id: int
    export_ms: float
    full: Graph
    repeats: list[Graph] = field(default_factory=list)


@dataclass(eq=False)
class GraphSet:
    directory: Path
    meta: dict
    sites: list[SiteGraphs]

    def digest(self) -> str:
        h = hashlib.sha256()
        for s in self.meta["sites"]:
            for name, sha in sorted(s["sha256"].items()):
                h.update(f"{s['site']}/{name}:{sha}\n".encode())
        return h.hexdigest()


def _graph(d: Path, name: str, width: int, rec: dict) -> Graph:
    nodes = (d / f"{name}.nodes.txt").read_text(encoding="utf-8").splitlines()
    x = np.fromfile(d / f"{name}.x.f32", dtype="<f4").reshape(len(nodes), width)
    e = pd.read_csv(d / f"{name}.edges.csv")
    g = Graph(name, nodes, x, np.vstack([e["src"].to_numpy(), e["dst"].to_numpy()]).astype(np.int64))
    if rec["repeat"] is not None:
        g.repeat, g.seed = int(rec["repeat"]), int(rec["seed"])
        g.queries = pd.read_csv(d / f"{name}.queries.csv", dtype=str)
        g.pairs = pd.read_csv(d / f"{name}.pairs.csv", dtype={"target": str, "donor": str})
    return g


def load(directory: str | Path) -> GraphSet:
    d = Path(directory)
    meta = json.loads((d / "graphs.json").read_text(encoding="utf-8"))
    sites = []
    for s in meta["sites"]:
        sd = d / s["site"]
        graphs = {r["name"]: _graph(sd, r["name"], int(s["width"]), r) for r in s["graphs"]}
        sites.append(
            SiteGraphs(
                s["site"],
                s["architectureClass"],
                int(s["runId"]),
                float(s.get("exportMs", np.nan)),
                graphs["full"],
                sorted([g for g in graphs.values() if g.repeat is not None], key=lambda g: g.repeat),
            )
        )
    return GraphSet(d, meta, sites)


# ---------- model ----------


def _params(meta: dict) -> dict:
    p = dict(meta["graphsage"])
    for k in ("layers", "hidden", "epochs", "negative_ratio"):
        p[k] = int(p[k])
    return p


def _torch():
    import torch

    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)
    return torch


def build_model(in_dim: int, p: dict):
    torch = _torch()
    from torch import nn
    from torch_geometric.nn import SAGEConv

    class SageLink(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            dims = [in_dim] + [p["hidden"]] * p["layers"]
            self.convs = nn.ModuleList(SAGEConv(a, b, aggr="mean") for a, b in zip(dims, dims[1:]))
            self.dropout = float(p["dropout"])
            self.decoder = nn.Sequential(
                nn.Linear(2 * p["hidden"], p["hidden"]), nn.ReLU(), nn.Linear(p["hidden"], 1)
            )

        def encode(self, x, edge_index):
            for i, conv in enumerate(self.convs):
                x = conv(x, edge_index)
                if i < len(self.convs) - 1:
                    x = torch.relu(x)
                    x = nn.functional.dropout(x, self.dropout, self.training)
            return x

        def decode(self, z, src, dst):
            return self.decoder(torch.cat([z[src], z[dst]], dim=-1)).squeeze(-1)

    return SageLink()


def _undirected(edges: np.ndarray, n: int):
    torch = _torch()
    from torch_geometric.utils import to_undirected

    return to_undirected(torch.as_tensor(edges, dtype=torch.long), num_nodes=n)


@dataclass
class Scaler:
    """Standardises the structural columns (after the embedding) with training statistics."""

    start: int
    mean: np.ndarray
    std: np.ndarray

    @staticmethod
    def fit(graphs: list[Graph], start: int) -> "Scaler":
        s = np.vstack([g.x[:, start:] for g in graphs]).astype(np.float64)
        std = s.std(axis=0)
        return Scaler(start, s.mean(axis=0), np.where(std > 0, std, 1.0))

    def __call__(self, x: np.ndarray) -> np.ndarray:
        out = x.astype(np.float32).copy()
        out[:, self.start :] = ((x[:, self.start :] - self.mean) / self.std).astype(np.float32)
        return out


def train(graphs: list[Graph], meta: dict, embedding_dim: int, seed: int):
    """Fits one model on `graphs` (their edges only); returns (model, scaler)."""
    torch = _torch()
    from torch_geometric.utils import negative_sampling

    p = _params(meta)
    # PyG's negative sampler draws from Python's and NumPy's global generators, not torch's.
    import random

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    scaler = Scaler.fit(graphs, embedding_dim)
    data = [(torch.as_tensor(scaler(g.x)), g.edges, len(g.nodes)) for g in graphs if g.edges.shape[1] > 1]
    model = build_model(graphs[0].x.shape[1], p)
    opt = torch.optim.Adam(model.parameters(), lr=float(p["learning_rate"]), weight_decay=float(p["weight_decay"]))
    loss_fn = torch.nn.BCEWithLogitsLoss()
    for _epoch in range(p["epochs"]):
        model.train()
        opt.zero_grad()
        total = 0.0
        for x, edges, n in data:
            e = edges.shape[1]
            perm = rng.permutation(e)
            k = max(1, int(round(float(p["supervision_share"]) * e)))
            sup, msg = edges[:, perm[:k]], edges[:, perm[k:]]
            z = model.encode(x, _undirected(msg, n))
            pos = torch.as_tensor(sup, dtype=torch.long)
            neg = negative_sampling(
                torch.as_tensor(edges, dtype=torch.long), num_nodes=n, num_neg_samples=k * p["negative_ratio"]
            )
            logits = torch.cat([model.decode(z, pos[0], pos[1]), model.decode(z, neg[0], neg[1])])
            labels = torch.cat([torch.ones(pos.shape[1]), torch.zeros(neg.shape[1])])
            loss = loss_fn(logits, labels)
            loss.backward()
            total += float(loss.detach())
        opt.step()
    model.eval()
    return model, scaler


def score_pairs(model, scaler: Scaler, g: Graph, donors: list[str], targets: list[str]) -> np.ndarray:
    """score(donor → target) on graph `g` (all its edges pass messages); NaN when not a node."""
    torch = _torch()
    idx = g.index
    ok = np.array([d in idx and t in idx for d, t in zip(donors, targets)], dtype=bool)
    out = np.full(len(donors), np.nan)
    if not ok.any():
        return out
    with torch.no_grad():
        z = model.encode(torch.as_tensor(scaler(g.x)), _undirected(g.edges, len(g.nodes)))
        src = torch.as_tensor([idx[d] for d, k in zip(donors, ok) if k], dtype=torch.long)
        dst = torch.as_tensor([idx[t] for t, k in zip(targets, ok) if k], dtype=torch.long)
        out[ok] = model.decode(z, src, dst).numpy().astype(np.float64)
    return out


# ---------- E6 ----------


def e6_rows(g: Graph, scores: np.ndarray) -> pd.DataFrame:
    """One row per (query, candidate) of a repeat, as E6 defines them, with every method's score."""
    pairs = g.pairs.assign(graphsage=scores)
    pairs["cosine"] = pairs["cosine"].fillna(-np.inf)
    by_target = {t: d for t, d in pairs.groupby("target", sort=False)}
    rows = []
    for t, qs in g.queries.groupby("target", sort=True):
        donors = set(qs["donor"])
        cand = by_target[t]
        for d in sorted(donors):
            c = cand[~cand["donor"].isin(donors - {d})]
            rows.append(c.assign(query=f"{g.repeat}|{t}|{d}", label=(c["donor"] == d).astype(int)))
    if not rows:
        return pd.DataFrame(columns=["query", "label", *METHODS])
    return pd.concat(rows, ignore_index=True)


def e6_metrics(site: SiteGraphs, ks: list[int], repeat_scores: dict[int, np.ndarray]) -> list[dict]:
    """Per repeat and method: E6's metrics (mean over queries), plus the repeat's query count."""
    out = []
    for g in site.repeats:
        rows = e6_rows(g, repeat_scores[g.repeat])
        if rows.empty:
            continue
        rows["graphsage"] = rows["graphsage"].fillna(-np.inf)
        for m in METHODS:
            s = summarise(query_metrics(rows, rows[m].to_numpy(dtype=float), ks), ks)
            for metric, v in s.items():
                out.append({"site": site.id, "architecture_class": site.architecture_class,
                            "repeat": g.repeat, "method": m, "metric": metric, "value": v})
    return out


# ---------- cross-validation ----------


def _round(a: np.ndarray) -> list[float]:
    return [float(f"{v:.6g}") for v in a]


def cross_validate(gs: GraphSet, out: str | Path, dataset: str | Path | None = None) -> pd.DataFrame:
    """Leave-one-site-out: for each site, train on the other sites' masked repeat graphs, then
    score its repeats' E6 pairs and its full graph's fixes (and, with the L13 `dataset`, its fix
    and E3 pool rows). Writes predictions/<site>.json (the graphsage-scores payload),
    scores/<site>/{e6,fixes,pool}.csv (for the L13 ranker), e6_metrics.csv and runtime.csv."""
    out = Path(out)
    (out / "predictions").mkdir(parents=True, exist_ok=True)
    ks = [int(k) for k in gs.meta["ks"]]
    seed = int(gs.meta["seed"])
    # A site without pages with text (nothing crawled as HTML) has no graph to learn from or score.
    usable = {s["site"] for s in gs.meta["sites"] if any(g["nodes"] > 0 for g in s["graphs"])}
    emb = int(next(s["embeddingDim"] for s in gs.meta["sites"] if s["site"] in usable))
    params = _params(gs.meta)
    digest = gs.digest()
    created = datetime.now(timezone.utc).isoformat()
    metric_rows, runtime_rows = [], []
    for site in gs.sites:
        if site.id not in usable:
            print(f"{site.id}: no pages with text, skipped")
            continue
        others = [s for s in gs.sites if s.id != site.id and s.id in usable]
        t0 = time.perf_counter()
        model, scaler = train([g for s in others for g in s.repeats], gs.meta, emb, seed)
        train_ms = (time.perf_counter() - t0) * 1000
        t1 = time.perf_counter()
        repeat_scores = {
            g.repeat: score_pairs(model, scaler, g, list(g.pairs["donor"]), list(g.pairs["target"])) for g in site.repeats
        }
        sd = out / "scores" / site.id
        sd.mkdir(parents=True, exist_ok=True)
        pd.concat(
            [g.pairs[["target", "donor"]].assign(repeat=g.repeat, score=repeat_scores[g.repeat]) for g in site.repeats]
            or [pd.DataFrame(columns=["target", "donor", "repeat", "score"])],
            ignore_index=True,
        )[["repeat", "target", "donor", "score"]].to_csv(sd / "e6.csv", index=False, lineterminator="\n")
        fixes: dict[str, float] = {}
        if dataset is not None:
            for kind, key in (("fixes", "fix_id"), ("pool", "entry_id")):
                f = Path(dataset) / site.id / f"{kind}.csv"
                if not f.exists():
                    continue
                df = pd.read_csv(f, usecols=[key, "donor", "target"], dtype=str)
                s = score_pairs(model, scaler, site.full, list(df["donor"]), list(df["target"]))
                df.assign(score=s)[[key, "score"]].to_csv(sd / f"{kind}.csv", index=False, lineterminator="\n")
                if kind == "fixes":
                    fixes = {k: float(f"{v:.6g}") for k, v in zip(df[key], s) if not np.isnan(v)}
        score_ms = (time.perf_counter() - t1) * 1000

        nodes = sorted({n for g in site.repeats for n in g.nodes})
        at = {n: i for i, n in enumerate(nodes)}
        repeats = []
        for g in site.repeats:
            pairs = g.pairs.assign(score=repeat_scores[g.repeat]).dropna(subset=["score"])
            repeats.append(
                {
                    "repeat": g.repeat,
                    "seed": g.seed,
                    "targets": [
                        {"target": at[t], "donors": [at[d] for d in p["donor"]], "scores": _round(p["score"].to_numpy())}
                        for t, p in pairs.groupby("target", sort=True)
                    ],
                }
            )
        prediction = {
            "site": site.id,
            "runId": site.run_id,
            "model": {
                "site": site.id,
                "trainedOn": [s.id for s in others],
                "params": {k: float(v) for k, v in params.items()},
                "dataset": digest,
                "createdAt": created,
                "runtimeMs": {"export": site.export_ms, "train": round(train_ms), "score": round(score_ms)},
            },
            "nodes": nodes,
            "repeats": repeats,
            "fixes": fixes,
        }
        (out / "predictions" / f"{site.id}.json").write_text(json.dumps(prediction) + "\n", encoding="utf-8")
        metric_rows += e6_metrics(site, ks, repeat_scores)
        runtime_rows.append(
            {
                "site": site.id,
                "architecture_class": site.architecture_class,
                "nodes": len(site.full.nodes),
                "body_edges": site.full.edges.shape[1],
                "training_graphs": sum(len(s.repeats) for s in others),
                "export_ms": site.export_ms,
                "train_ms": round(train_ms),
                "score_ms": round(score_ms),
            }
        )
    metrics = pd.DataFrame(metric_rows)
    metrics.to_csv(out / "e6_metrics.csv", index=False, lineterminator="\n")
    pd.DataFrame(runtime_rows).to_csv(out / "runtime.csv", index=False, lineterminator="\n")
    (out / "model.json").write_text(
        json.dumps({"dataset": digest, "graphsDir": str(gs.directory), "createdAt": created,
                    "cv": "leave-one-site-out", "params": params, "seed": seed, "ks": ks,
                    "methods": METHODS}, indent=1) + "\n",
        encoding="utf-8",
    )
    return metrics


def site_means(metrics: pd.DataFrame) -> pd.DataFrame:
    """A site's value per method and metric: the mean over its repeats (E6's summary)."""
    return (
        metrics.groupby(["site", "architecture_class", "method", "metric"], sort=True)["value"]
        .mean()
        .unstack("metric")
        .reset_index()
    )


def attach_scores(df: pd.DataFrame, scores_dir: Path, site: str, kind: str) -> pd.DataFrame:
    """The L13 ranker's optional `graphsage` feature: this site's held-out GraphSAGE score of each
    row (E6 rows by repeat, target and donor; fix and pool rows by id). NaN when unscored."""
    f = scores_dir / site / f"{'fixes' if kind == 'ratings' else kind}.csv"
    if not f.exists() or df.empty:
        return df.assign(graphsage=np.nan)
    s = pd.read_csv(f, dtype={"target": str, "donor": str})
    if kind == "e6":
        s["repeat"] = s["repeat"].astype(df["repeat"].dtype)
        return df.merge(s, on=["repeat", "target", "donor"], how="left", validate="many_to_one").rename(
            columns={"score": "graphsage"}
        )
    key = "fix_id" if kind in ("fixes", "ratings") else "entry_id"
    s = s.rename(columns={"score": "graphsage"})
    return df.merge(s[[key, "graphsage"]], on=key, how="left", validate="many_to_one")
