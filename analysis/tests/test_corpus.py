"""The corpus export: the real output of the eval package (fixtures/corpus-export, written by
`LINKLENS_WRITE_FIXTURES=1 pnpm --filter @linklens/eval test:integration`) and a synthetic
three-class batch for the statistics and figures."""

import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from linklens_analysis import corpus, style
from linklens_analysis.__main__ import main

from plotting import needs_matplotlib

FIXTURES = Path(__file__).parent / "fixtures"
CSV_TS = Path(__file__).parents[2] / "packages" / "eval" / "src" / "corpus" / "csv.ts"


def ts_columns(name: str) -> list[str]:
    text = CSV_TS.read_text(encoding="utf-8")
    body = re.search(rf"export const {name} = \[(.*?)\] as const;", text, re.S)
    assert body, f"{name} not found in {CSV_TS}"
    return re.findall(r'"([^"]+)"', body.group(1))


@pytest.mark.parametrize(
    "name",
    [
        "METRICS_COLUMNS",
        "CHANNELS_COLUMNS",
        "E3_COLUMNS",
        "E4_COLUMNS",
        "E4_PAGES_COLUMNS",
        "E5_COLUMNS",
        "E5_CATEGORIES_COLUMNS",
        "E5_DISAGREEMENTS_COLUMNS",
        "E6_COLUMNS",
        "E7_COLUMNS",
        "E7_SIGMA_PAIRS_COLUMNS",
        "POLICY_PAIRS_COLUMNS",
        "SITES_COLUMNS",
        "STAGES_COLUMNS",
    ],
)
def test_columns_match_the_typescript_export(name):
    assert getattr(corpus, name) == ts_columns(name)


def test_loads_the_real_export():
    b = corpus.load_batch(FIXTURES / "corpus-export")
    assert b.batch_id == "int"
    assert list(b.metrics["policy"].cat.categories) == list(style.POLICIES)
    assert sorted(b.metrics["policy"].unique()) == list(style.POLICIES)
    assert b.metrics.loc[b.metrics["is_audit_policy"], "policy"].unique().tolist() == ["P3"]
    w = corpus.wide(b.metrics, "P3")
    assert w.loc[("docs", "ocean"), "discovery.orphans"] == 1
    assert b.sites.loc[0, "notes"] == "fixture, with a comma"
    assert b.sites.loc[0, "duration_s"] == 90


def synthetic(tmp_path: Path) -> Path:
    """3 classes × 4 sites × 6 policies; docs are much deeper than the rest."""
    rng = np.random.default_rng(42)
    rows = []
    sites = []
    for cls, depth in [("cms-blog", 2.0), ("ecommerce-catalogue", 2.5), ("documentation", 6.0)]:
        for i in range(4):
            sid = f"{cls[:4]}-{i}"
            sites.append(
                {"batch_id": "syn", "site_id": sid, "architecture_class": cls, "url": f"https://{sid}.test/",
                 "notes": "", "status": "completed", "run_id": len(sites) + 1, "attempts": 1,
                 "audit_policy": "P3", "pages_fetched": 500, "fetches": 520, "started_at": "", "finished_at": "",
                 "duration_s": 60.0, "commit": "abc", "model_sha256": "m", "error": ""}
            )
            for j, p in enumerate(style.POLICIES):
                base = {"batch_id": "syn", "site_id": sid, "architecture_class": cls, "run_id": len(sites),
                        "policy": p, "policy_version": f"{p}@1.0.0", "is_audit_policy": int(p == "P3")}
                rows.append({**base, "metric": "graph.mean_depth", "value": depth + rng.normal(0, 0.2)})
                rows.append({**base, "metric": "graph.nodes", "value": 500 - 20 * j + i})
                rows.append({**base, "metric": "graph.pagerank_converged", "value": 1})
    d = tmp_path / "syn"
    d.mkdir()
    pd.DataFrame(rows, columns=corpus.METRICS_COLUMNS).to_csv(d / "metrics.csv", index=False)
    pd.DataFrame(sites, columns=corpus.SITES_COLUMNS).to_csv(d / "sites.csv", index=False)
    pd.DataFrame(columns=corpus.STAGES_COLUMNS).to_csv(d / "stages.csv", index=False)
    pd.DataFrame(columns=corpus.POLICY_PAIRS_COLUMNS).to_csv(d / "policy_pairs.csv", index=False)
    pd.DataFrame(columns=corpus.CHANNELS_COLUMNS).to_csv(d / "channels.csv", index=False)
    pd.DataFrame(columns=corpus.E3_COLUMNS).to_csv(d / "e3.csv", index=False)
    pd.DataFrame(columns=corpus.E4_COLUMNS).to_csv(d / "e4.csv", index=False)
    pd.DataFrame(columns=corpus.E4_PAGES_COLUMNS).to_csv(d / "e4_pages.csv", index=False)
    pd.DataFrame(columns=corpus.E5_COLUMNS).to_csv(d / "e5.csv", index=False)
    pd.DataFrame(columns=corpus.E5_CATEGORIES_COLUMNS).to_csv(d / "e5_categories.csv", index=False)
    pd.DataFrame(columns=corpus.E5_DISAGREEMENTS_COLUMNS).to_csv(d / "e5_disagreements.csv", index=False)
    pd.DataFrame(columns=corpus.E6_COLUMNS).to_csv(d / "e6.csv", index=False)
    pd.DataFrame(columns=corpus.E7_COLUMNS).to_csv(d / "e7.csv", index=False)
    pd.DataFrame(columns=corpus.E7_SIGMA_PAIRS_COLUMNS).to_csv(d / "e7_sigma_pairs.csv", index=False)
    return d


def test_rejects_wrong_columns_and_duplicates(tmp_path):
    d = synthetic(tmp_path)
    m = pd.read_csv(d / "metrics.csv")
    pd.concat([m, m.head(1)]).to_csv(d / "metrics.csv", index=False)
    with pytest.raises(ValueError, match="twice"):
        corpus.load_batch(d)
    m.rename(columns={"value": "val"}).to_csv(d / "metrics.csv", index=False)
    with pytest.raises(ValueError, match="expected columns"):
        corpus.load_batch(d)


def test_class_summary_and_comparison(tmp_path):
    b = corpus.load_batch(synthetic(tmp_path))
    s = corpus.class_summary(b.metrics, "graph.mean_depth")
    assert list(s.index) == list(style.CLASSES)  # fixed class order
    assert (s["sites"] == 4).all()
    assert s.loc["documentation", "median"] > s.loc["cms-blog", "median"]

    c = corpus.compare_classes(b.metrics, "P3", ["graph.mean_depth", "graph.pagerank_converged", "missing"])
    assert c.loc["graph.mean_depth", "p"] < 0.05
    assert 0 < c.loc["graph.mean_depth", "epsilon_sq"] <= 1
    assert np.isnan(c.loc["graph.pagerank_converged", "p"])  # no variation
    assert c.loc["missing", "sites"] == 0
    assert c.loc["graph.mean_depth", "p_holm"] >= c.loc["graph.mean_depth", "p"]


def test_holm():
    np.testing.assert_allclose(corpus.holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])
    out = corpus.holm([np.nan, 0.2])
    assert np.isnan(out[0]) and out[1] == 0.2


def test_policy_effect(tmp_path):
    b = corpus.load_batch(synthetic(tmp_path))
    e = corpus.policy_effect(b.metrics, "graph.nodes")  # falls with every policy
    assert e["sites"] == 12 and e["p"] < 0.001
    assert np.isnan(corpus.policy_effect(b.metrics, "graph.pagerank_converged")["p"])


def test_report(tmp_path):
    md = corpus.report(synthetic(tmp_path))
    assert "## Corpus batch syn" in md and "graph.mean_depth" in md and "| documentation" in md


@needs_matplotlib
def test_figures(tmp_path):
    d = synthetic(tmp_path)
    b = corpus.load_batch(d)
    out = tmp_path / "fig"
    written = corpus.figures(b, out, ["graph.mean_depth", "graph.nodes", "not-there"])
    assert sorted(p.name for p in written) == sorted(
        f"{k}_{m}.{ext}"
        for k in ["by_class", "policies"]
        for m in ["graph_mean_depth", "graph_nodes"]
        for ext in ["pdf", "png"]
    )
    assert all(p.stat().st_size > 0 for p in written)


def test_cli_report(tmp_path, capsys):
    assert main(["corpus", str(synthetic(tmp_path))]) == 0
    assert "Kruskal" in capsys.readouterr().out


@needs_matplotlib
def test_cli_figures(tmp_path, capsys):
    d = synthetic(tmp_path)
    assert main(["corpus", str(d), "--figures", str(tmp_path / "f")]) == 0
    assert "Kruskal" in capsys.readouterr().out
    assert (tmp_path / "f" / "by_class_graph_mean_depth.pdf").exists()
