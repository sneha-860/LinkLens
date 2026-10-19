"""Deployable models and the pipeline's scorer (`python -m ml fit | gnn-fit | score`).

The offline evaluation (model.cross_validate, gnn.cross_validate) is leave-one-site-out: every
site's predictions come from a model that never saw it. A live audit is a new site, so the
pipeline needs one model fit on every labelled corpus site:

- `fit`: the LightGBM lambdarank ranker on all sites' E6 rows, saved as LightGBM's text model;
- `gnn-fit`: the GraphSAGE link predictor on all sites' masked repeat graphs (state dict, the
  structural-feature scaler and the architecture).

Each model directory holds `model.json` (what it was trained on, how, and the dataset digest) next
to its weights. Its version of record is the SHA-256 over its files (`model_sha256`); the scorer
reports it with every response, the pipeline stores it in the artefact, and the corpus manifest
records it.

`score` is the pipeline's entry point: one JSON request in, one JSON response out (protocol
`linklens-scorer@1`, packages/core/src/fixes/scorers.ts). A CLI rather than a service: it runs
once per audit stage, needs no port, process supervision or authentication of its own, starts
in the same environment as training, and is deterministic (one thread, a fresh process).
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import pandas as pd

from .data import PAGE_TYPES, Dataset
from .metrics import percentile_priority

PROTOCOL = "linklens-scorer@1"
RANKER_FORMAT = "lightgbm-text@1"
GNN_FORMAT = "graphsage-state-dict@1"


def _host(url: str | None) -> str | None:
    if not url:
        return None
    h = (urlsplit(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else (h or None)


def model_files(d: Path) -> list[dict]:
    """Every file of a model directory with its size and SHA-256, sorted by its posix name (as
    the corpus manifest sorts them: packages/eval/src/corpus/manifest.ts scoringModelInfo)."""
    out = []
    for p in (x for x in d.rglob("*") if x.is_file()):
        data = p.read_bytes()
        out.append({"name": p.relative_to(d).as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return sorted(out, key=lambda f: f["name"])


def model_sha256(files: list[dict]) -> str:
    """The model's version of record: SHA-256 over "name\\0sha256\\n" of its files."""
    return hashlib.sha256("".join(f"{f['name']}\0{f['sha256']}\n" for f in files).encode()).hexdigest()


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=1, sort_keys=True) + "\n", encoding="utf-8")


# ---------- fitting ----------


def fit_ranker(ds: Dataset, out: str | Path) -> Path:
    """The ranker fit on every site with E6 labels; writes <out>/ranker/{model.txt, model.json}."""
    from .model import lgb_params, train

    if "graphsage" in ds.features:
        raise ValueError("the deployable ranker cannot use the graphsage feature: the pipeline scores the ranker first")
    labelled = [s for s in ds.sites if s.e6["query"].nunique() > 0]
    if len(labelled) < 2:
        raise ValueError("a deployable ranker needs E6 labels on at least two sites")
    booster = train(pd.concat([s.e6 for s in labelled], ignore_index=True), ds)
    params, rounds = lgb_params(ds.meta)
    d = Path(out) / "ranker"
    d.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(d / "model.txt"))
    hosts = {s["site"]: _host(s.get("url")) for s in ds.meta["sites"]}
    _write_json(
        d / "model.json",
        {
            "kind": "ranker",
            "format": RANKER_FORMAT,
            "labels": "e6",
            "features": ds.features,
            "categorical": ds.categorical,
            "pageTypes": PAGE_TYPES,
            "params": {k: v for k, v in params.items() if isinstance(v, (int, float)) and not isinstance(v, bool)},
            "numBoostRound": rounds,
            "trainedOn": [s.id for s in labelled],
            "trainedOnHosts": sorted(h for s in labelled if (h := hosts.get(s.id))),
            "dataset": ds.digest(),
            "datasetDir": str(ds.directory),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    return d


def fit_gnn(gs, out: str | Path) -> Path:
    """The GraphSAGE predictor fit on every usable site's masked repeats; writes
    <out>/graphsage/{model.pt, model.json} (the scaler is in model.json)."""
    from . import gnn

    torch = gnn._torch()
    # As in cross-validation: a site without pages with text has no graph to learn from.
    with_pages = {m["site"] for m in gs.meta["sites"] if any(g["nodes"] > 0 for g in m["graphs"])}
    usable = [s for s in gs.sites if s.id in with_pages]
    if len(usable) < 2:
        raise ValueError("a deployable GraphSAGE model needs graphs of at least two sites")
    emb = int(next(m["embeddingDim"] for m in gs.meta["sites"] if m["site"] == usable[0].id))
    graphs = [g for s in usable for g in s.repeats]
    model, scaler = gnn.train(graphs, gs.meta, emb, int(gs.meta["seed"]))
    d = Path(out) / "graphsage"
    d.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), d / "model.pt")
    hosts = {m["site"]: _host(m.get("url")) for m in gs.meta["sites"]}
    _write_json(
        d / "model.json",
        {
            "kind": "graphsage",
            "format": GNN_FORMAT,
            "labels": "body-links",
            "inDim": int(graphs[0].x.shape[1]),
            "embeddingDim": emb,
            "structural": list(gs.meta["structural"]),
            "params": {k: float(v) for k, v in gnn._params(gs.meta).items()},
            "scaler": {"start": scaler.start, "mean": scaler.mean.tolist(), "std": scaler.std.tolist()},
            "seed": int(gs.meta["seed"]),
            "trainedOn": [s.id for s in usable],
            "trainedOnHosts": sorted(h for s in usable if (h := hosts.get(s.id))),
            "dataset": gs.digest(),
            "graphsDir": str(gs.directory),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    return d


# ---------- scoring ----------


def _model_dir(models: Path, kind: str) -> Path:
    d = models / kind
    if not (d / "model.json").exists():
        raise FileNotFoundError(f"no {kind} model in {models} (run `python -m ml {'fit' if kind == 'ranker' else 'gnn-fit'}`)")
    return d


def _info(d: Path, meta: dict) -> dict:
    files = model_files(d)
    return {
        "kind": meta["kind"],
        "sha256": model_sha256(files),
        "files": files,
        "trainedOn": meta["trainedOn"],
        "trainedOnHosts": meta.get("trainedOnHosts", []),
        "labels": meta["labels"],
        "dataset": meta["dataset"],
        "createdAt": meta["createdAt"],
        "features": meta.get("features", meta.get("structural", [])),
        "params": meta["params"],
    }


def score_ranker(request: dict, models: Path) -> dict:
    import lightgbm as lgb

    from .model import contributions, top_contributions

    d = _model_dir(models, "ranker")
    meta = json.loads((d / "model.json").read_text(encoding="utf-8"))
    features = list(meta["features"])
    missing = [f for f in features if f not in request["features"]]
    if missing:
        raise ValueError(f"the request lacks the model's features {missing}")
    booster = lgb.Booster(model_file=str(d / "model.txt"))
    rows = pd.DataFrame(request["rows"], columns=["fix_id", *request["features"]])
    X = rows[features].copy()
    for c in features:
        if c in meta["categorical"]:
            X[c] = pd.Categorical(X[c].astype(str), categories=meta["pageTypes"])
        else:
            X[c] = pd.to_numeric(X[c], errors="raise").astype(float)
    raw = np.asarray(booster.predict(X)) if len(X) else np.zeros(0)
    tops = top_contributions(X, contributions(booster, X), features, int(request["shapTop"]))
    fixes = {
        fid: {"priority": float(p), "raw": float(r), "shap": [{k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in c.items()} for c in t]}
        for fid, p, r, t in zip(rows["fix_id"], percentile_priority(raw), raw, tops)
    }
    return {"protocol": PROTOCOL, "kind": "ranker", "model": _info(d, meta), "fixes": fixes}


def score_graphsage(request: dict, models: Path) -> dict:
    from . import gnn

    torch = gnn._torch()
    d = _model_dir(models, "graphsage")
    meta = json.loads((d / "model.json").read_text(encoding="utf-8"))
    if list(request["structural"]) != list(meta["structural"]):
        raise ValueError(f"structural features {request['structural']} differ from the model's {meta['structural']}")
    nodes = list(request["nodes"])
    width = int(request["embeddingDim"]) + len(request["structural"])
    if width != int(meta["inDim"]):
        raise ValueError(f"node features of width {width}, the model expects {meta['inDim']}")
    x = np.frombuffer(base64.b64decode(request["x"]), dtype="<f4").reshape(len(nodes), width)
    g = gnn.Graph("full", nodes, x, np.array([request["src"], request["dst"]], dtype=np.int64).reshape(2, -1))
    model = gnn.build_model(width, gnn._params({"graphsage": meta["params"]}))
    model.load_state_dict(torch.load(d / "model.pt", weights_only=True))
    model.eval()
    s = meta["scaler"]
    scaler = gnn.Scaler(int(s["start"]), np.asarray(s["mean"]), np.asarray(s["std"]))
    pairs = request["pairs"]
    scores = gnn.score_pairs(model, scaler, g, [p["donor"] for p in pairs], [p["target"] for p in pairs]) if pairs else np.zeros(0)
    return {
        "protocol": PROTOCOL,
        "kind": "graphsage",
        "model": _info(d, meta),
        "scores": {p["id"]: float(f"{v:.6g}") for p, v in zip(pairs, scores) if not np.isnan(v)},
    }


def score(request_path: str | Path, models: str | Path, out_path: str | Path) -> dict:
    """Answer one scorer request (see the module docstring); writes and returns the response."""
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    if request.get("protocol") != PROTOCOL:
        raise ValueError(f"unknown protocol {request.get('protocol')!r} (expected {PROTOCOL})")
    kind = request.get("kind")
    if kind == "ranker":
        response = score_ranker(request, Path(models))
    elif kind == "graphsage":
        response = score_graphsage(request, Path(models))
    else:
        raise ValueError(f"unknown request kind {kind!r}")
    Path(out_path).write_text(json.dumps(response) + "\n", encoding="utf-8")
    return response
