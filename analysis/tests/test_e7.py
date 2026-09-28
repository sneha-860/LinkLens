"""E7 across the corpus: the σ / ε / α ablation (e7.csv, e7_sigma_pairs.csv)."""

from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from linklens_analysis import corpus, e7, results
from linklens_analysis.__main__ import main
from plotting import needs_matplotlib

FIXTURES = Path(__file__).parent / "fixtures"
EPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]
ALPHAS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3]
EPS0, ALPHA0 = 0.2, 0.1


def synthetic(sites_per_class: int = 3, seed: int = 42) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The hybrid recovers best and falls as ε rises (its gate); the other σ are flat in ε; the
    top-k overlap with the default falls away from the default ε and α."""
    rng = np.random.default_rng(seed)
    rows, pairs = [], []
    for cls in ("cms-blog", "ecommerce-catalogue", "documentation"):
        for i in range(sites_per_class):
            site = f"{cls[:4]}-{i}"
            settings = {(s, e, ALPHA0) for s in e7.SIGMAS for e in EPS} | {
                (s, EPS0, a) for s in e7.SIGMAS for a in ALPHAS
            }
            for sigma, eps, alpha in sorted(settings):
                sweeps = "|".join(
                    x
                    for x, on in [
                        ("sigma", eps == EPS0 and alpha == ALPHA0),
                        ("epsilon", alpha == ALPHA0),
                        ("alpha", eps == EPS0),
                    ]
                    if on
                )
                is_default = sigma == "refGateCosine" and eps == EPS0 and alpha == ALPHA0
                overlap = 1.0 if is_default else max(0.0, 0.9 - abs(eps - EPS0) - abs(alpha - ALPHA0))
                if sigma != "refGateCosine" and eps == EPS0 and alpha == ALPHA0:
                    overlap = 0.6
                mrr = {"refGateCosine": 0.5 - 0.5 * (eps - 0.05), "cosineOnly": 0.4, "refOnly": 0.3, "blended": 0.42}[sigma]
                ours = 0.02 + 0.01 * rng.uniform()
                values = {
                    "fixes": 40,
                    "topk_jaccard_default": overlap,
                    "e3_pool": 20,
                    "e3_linklens@10": ours,
                    "e3_random@10": 0.01,
                    "e3_gain@10": ours - 0.01,
                    "e6_mrr": mrr,
                    "e6_recall@10": min(1, 2 * mrr),
                    "e6_auc": 0.5 + mrr,
                }
                for metric, value in values.items():
                    rows.append(
                        {"batch_id": "syn", "site_id": site, "architecture_class": cls, "run_id": 1,
                         "policy": "P3", "sigma": sigma, "epsilon": eps, "alpha": alpha,
                         "is_default": int(is_default), "sweeps": sweeps, "metric": metric, "value": value}
                    )
            for a, b in combinations(e7.SIGMAS, 2):
                pairs.append(
                    {"batch_id": "syn", "site_id": site, "architecture_class": cls, "run_id": 1,
                     "sigma_a": a, "sigma_b": b, "k": 10, "jaccard": 0.6 if "refGateCosine" in (a, b) else 0.8}
                )
    return (
        pd.DataFrame(rows, columns=corpus.E7_COLUMNS),
        pd.DataFrame(pairs, columns=corpus.E7_SIGMA_PAIRS_COLUMNS),
    )


@pytest.fixture()
def data():
    return synthetic()


def test_ablation_table(data):
    rows, _ = data
    t = e7.ablation_table(rows)
    assert list(t.index) == [e7.SIGMA_LABELS[s] for s in e7.SIGMAS]
    assert t.attrs["setting"] == "ε = 0.2, α = 0.1"
    assert list(t.columns) == ["sites", "Top-k overlap with default", "E3 ΔPR@10", "E3 gain@10", "E6 MRR", "E6 R@10", "E6 AUC"]
    assert t.loc["Hybrid (REF-gated cosine)", "Top-k overlap with default"].startswith("1 [")
    assert t.loc["Cosine only", "E6 MRR"].startswith("0.4 [")
    assert t.loc["Hybrid (REF-gated cosine)", "sites"] == 9
    docs = e7.ablation_table(rows, scope="documentation")
    assert docs.loc["REF only", "sites"] == 3


def test_sigma_pair_matrix(data):
    _, pairs = data
    m = e7.sigma_pair_matrix(pairs)
    assert m.shape == (4, 4)
    assert (np.diag(m.to_numpy()) == 1).all()
    assert m.loc["Hybrid (REF-gated cosine)", "Cosine only"] == pytest.approx(0.6)
    assert m.loc["REF only", "Blended"] == pytest.approx(0.8)
    assert (m.to_numpy() == m.to_numpy().T).all()


def test_curves(data):
    rows, _ = data
    c = e7.curve(rows, "epsilon", "e6_mrr")
    assert list(c.index) == EPS
    assert list(c.columns) == e7.SIGMAS
    # The hybrid's recovery falls as ε rises (its gate); cosine alone is flat.
    assert c["refGateCosine"].is_monotonic_decreasing
    assert c["cosineOnly"].nunique() == 1
    a = e7.curve(rows, "alpha", "topk_jaccard_default")
    assert list(a.index) == ALPHAS
    assert a.loc[ALPHA0, "refGateCosine"] == 1
    assert e7.curve(rows, "alpha", "no-such-metric").empty
    with pytest.raises(ValueError):
        e7.curve(rows, "lambda", "e6_mrr")


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    assert e7.defaults(b.e7) == (0.2, 0.1)
    t = e7.ablation_table(b.e7)
    assert len(t) == 4
    assert t.loc["Hybrid (REF-gated cosine)", "Top-k overlap with default"] == "1"
    assert len(b.e7_pairs) == 6
    assert list(e7.curve(b.e7, "epsilon", "topk_jaccard_default").index) == EPS


def test_single_run_e7_tables():
    tables = dict(results.tables(results.load(FIXTURES / "E7.json")))
    t = tables["σ ablation"]
    assert set(t.index) == set(e7.SIGMAS)
    assert len(tables["σ pairs"]) == 6


def write_batch(tmp_path: Path, rows: pd.DataFrame, pairs: pd.DataFrame) -> Path:
    d = tmp_path / "batch"
    d.mkdir()
    for f in (FIXTURES / "corpus-export").glob("*.csv"):
        if f.name not in ("e7.csv", "e7_sigma_pairs.csv"):
            (d / f.name).write_bytes(f.read_bytes())
    rows.to_csv(d / "e7.csv", index=False)
    pairs.to_csv(d / "e7_sigma_pairs.csv", index=False)
    return d


def test_report_and_cli(tmp_path, data, capsys):
    d = write_batch(tmp_path, *data)
    md = e7.report(d)
    assert "### σ variants (ε = 0.2, α = 0.1" in md
    assert "Top-k overlap between σ variants" in md
    assert "across epsilon" in md and "across alpha" in md
    assert main(["e7", str(d)]) == 0
    assert "Hybrid (REF-gated cosine)" in capsys.readouterr().out


def test_report_without_results(tmp_path):
    d = write_batch(tmp_path, pd.DataFrame(columns=corpus.E7_COLUMNS), pd.DataFrame(columns=corpus.E7_SIGMA_PAIRS_COLUMNS))
    assert "No E7 results yet" in e7.report(d)


@needs_matplotlib
def test_curves_figures(tmp_path, data):
    written = e7.figures(data[0], tmp_path / "fig")
    assert sorted(p.name for p in written) == [
        "e7_alpha_curves.pdf",
        "e7_alpha_curves.png",
        "e7_epsilon_curves.pdf",
        "e7_epsilon_curves.png",
    ]


def with_imp(e7_df: pd.DataFrame, lift: float = 0.004) -> pd.DataFrame:
    """The synthetic export plus the scoring sweep: each σ at the default ε and α under S_imp,
    whose E3 gain is `lift` higher than under S."""
    df = e7.with_scoring(e7_df)
    at = (df["epsilon"] == EPS0) & (df["alpha"] == ALPHA0)
    df.loc[at, "sweeps"] = df.loc[at, "sweeps"] + "|scoring"
    imp = df[at].copy()
    imp["scoring"] = "S_imp"
    imp["sweeps"] = "scoring"
    imp["is_default"] = False
    imp.loc[imp["metric"] == "e3_gain@10", "value"] += lift
    imp.loc[imp["metric"] == "topk_jaccard_default", "value"] = 0.5
    return pd.concat([df, imp], ignore_index=True)


def test_scoring_table_compares_s_with_s_imp():
    df = with_imp(synthetic()[0])
    t = e7.scoring_table(df, k=10)
    assert list(t.index) == [e7.SIGMA_LABELS[s] for s in e7.SIGMAS]
    assert (t["sites"] == 9).all()
    # The difference is exactly the lift on every site, so its interval collapses on it.
    assert t.loc[e7.SIGMA_LABELS["refGateCosine"], "S_imp − S"].startswith("0.004")
    assert t["S_imp top-k overlap with default"].str.startswith("0.5").all()
    # S_imp rows never leak into the σ ablation or the ε / α curves.
    assert e7.ablation_table(df).equals(e7.ablation_table(synthetic()[0]))
    assert e7.curve(df, "epsilon", "e6_mrr").equals(e7.curve(synthetic()[0], "epsilon", "e6_mrr"))
    # Without S_imp rows there is no table.
    assert e7.scoring_table(synthetic()[0]).empty


def test_exports_without_the_scoring_column_still_load(tmp_path):
    import shutil

    d = tmp_path / "batch"
    shutil.copytree(FIXTURES / "corpus-export", d)
    legacy = pd.read_csv(d / "e7.csv").drop(columns=["scoring"])
    legacy.to_csv(d / "e7.csv", index=False)
    batch = corpus.load_batch(d)
    assert list(batch.e7.columns) == corpus.E7_COLUMNS
    assert (batch.e7["scoring"] == "S").all()
    assert corpus.load_batch(FIXTURES / "corpus-export").e7["scoring"].eq("S").all()
