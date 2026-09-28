"""The L13 dataset written by `l13 export`: dataset.json plus, per site, e6.csv (label rows of
the masked repeats), fixes.csv (the run's fixes), pool.csv (E3's pool) and ratings.csv (E8)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

# Page types (core config PAGE_TYPES): a fixed category set, so every fold encodes them alike.
PAGE_TYPES = ["homepage", "hub", "product", "article", "utility", "other"]


@dataclass
class Site:
    id: str
    architecture_class: str
    run_id: int
    e6: pd.DataFrame
    fixes: pd.DataFrame
    pool: pd.DataFrame
    ratings: pd.DataFrame


@dataclass
class Dataset:
    directory: Path
    meta: dict
    sites: list[Site] = field(default_factory=list)

    @property
    def features(self) -> list[str]:
        return list(self.meta["features"])

    @property
    def categorical(self) -> list[str]:
        return list(self.meta["categorical"])

    def digest(self) -> str:
        """SHA-256 over the dataset's files (recorded with every prediction)."""
        h = hashlib.sha256()
        for s in self.meta["sites"]:
            for name, sha in sorted(s["sha256"].items()):
                h.update(f"{s['site']}/{name}:{sha}\n".encode())
        return h.hexdigest()


def _read(path: Path, meta: dict) -> pd.DataFrame:
    df = pd.read_csv(path, keep_default_na=False, na_values=[""])
    for c in meta["numeric"]:
        if c in df:
            df[c] = pd.to_numeric(df[c], errors="raise").astype(float)
    for c in meta["categorical"]:
        if c in df:
            df[c] = pd.Categorical(df[c].astype(str), categories=PAGE_TYPES)
    return df


def load(directory: str | Path) -> Dataset:
    d = Path(directory)
    meta = json.loads((d / "dataset.json").read_text(encoding="utf-8"))
    ds = Dataset(d, meta)
    for s in meta["sites"]:
        sd = d / s["site"]
        ds.sites.append(
            Site(
                id=s["site"],
                architecture_class=s["architectureClass"],
                run_id=int(s["runId"]),
                e6=_read(sd / "e6.csv", meta),
                fixes=_read(sd / "fixes.csv", meta),
                pool=_read(sd / "pool.csv", meta),
                ratings=_read(sd / "ratings.csv", meta),
            )
        )
    missing = [f for f in meta["features"] if f not in ds.sites[0].e6.columns] if ds.sites else []
    if missing:
        raise ValueError(f"e6.csv lacks features {missing}")
    return ds
