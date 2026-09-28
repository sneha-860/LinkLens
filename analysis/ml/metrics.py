"""Ranking metrics in expectation over random tie-breaking, exactly as E6 defines them
(packages/eval/src/e6-masking.ts: rankOf, recallAt, reciprocalRank, auc), so the learned mode
and S are measured the same way E6 measures every method."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Ranking:
    above: int
    tied: int
    candidates: int


def rank_of(scores: np.ndarray, relevant: int) -> Ranking:
    s = scores[relevant]
    return Ranking(int((scores > s).sum()), int((scores == s).sum()), len(scores))


def recall_at(r: Ranking, k: int) -> float:
    return min(1.0, max(0.0, (k - r.above) / r.tied))


def reciprocal_rank(r: Ranking) -> float:
    return float(np.mean([1 / rank for rank in range(r.above + 1, r.above + r.tied + 1)]))


def auc(r: Ranking) -> float | None:
    others = r.candidates - 1
    if others <= 0:
        return None
    below = r.candidates - r.above - r.tied
    return (below + 0.5 * (r.tied - 1)) / others


def query_metrics(e6: pd.DataFrame, score: np.ndarray, ks: list[int]) -> pd.DataFrame:
    """Per E6 query: recall@k, reciprocal rank and AUC of its one positive under `score`."""
    rows = []
    df = e6.assign(_score=score)
    for q, g in df.groupby("query", sort=True):
        labels = g["label"].to_numpy()
        pos = np.flatnonzero(labels == 1)
        if len(pos) != 1:
            raise ValueError(f"query {q} has {len(pos)} positives")
        r = rank_of(g["_score"].to_numpy(dtype=float), int(pos[0]))
        rows.append(
            {"query": q, "rr": reciprocal_rank(r), "auc": auc(r), **{f"recall@{k}": recall_at(r, k) for k in ks}}
        )
    return pd.DataFrame(rows)


def summarise(per_query: pd.DataFrame, ks: list[int]) -> dict[str, float]:
    """Mean over queries (the E6 summary of one site)."""
    out = {"queries": float(len(per_query)), "mrr": float(per_query["rr"].mean())}
    for k in ks:
        out[f"recall@{k}"] = float(per_query[f"recall@{k}"].mean())
    out["auc"] = float(per_query["auc"].dropna().mean())
    return out


def percentile_priority(raw: np.ndarray) -> np.ndarray:
    """Mid-rank percentile of each raw score among all of them, in (0, 1): the priority."""
    raw = np.asarray(raw, dtype=float)
    if raw.size == 0:
        return raw
    order = np.sort(raw)
    below = np.searchsorted(order, raw, side="left")
    equal = np.searchsorted(order, raw, side="right") - below
    return (below + equal / 2) / raw.size
