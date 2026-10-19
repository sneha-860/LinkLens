"""python -m ml train <dataset dir> --out <model dir> | report <model dir> | gnn … |
fit <dataset dir> --out <models dir> | gnn-fit <graphs dir> --out <models dir> |
score <request.json> --models <models dir> --out <response.json>"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import data, model, report


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(prog="python -m ml")
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train", help="leave-one-site-out LightGBM lambdarank + TreeSHAP")
    t.add_argument("dataset")
    t.add_argument("--out", required=True)
    t.add_argument("--graphsage", help="a `gnn` output directory: adds its held-out scores as a feature")
    g = sub.add_parser("gnn", help="leave-one-site-out GraphSAGE link predictor (needs the gnn extra)")
    g.add_argument("graphs", help="the `l13 graph-export` directory")
    g.add_argument("--out", required=True)
    g.add_argument("--dataset", help="the L13 dataset directory, to score its fix and pool rows")
    gr = sub.add_parser("gnn-report", help="GraphSAGE vs REF, cosine and the hybrid on E6, and runtime")
    gr.add_argument("gnn")
    gr.add_argument("--ranker", help="L13 model directory without the graphsage feature")
    gr.add_argument("--ranker-graphsage", help="L13 model directory with it")
    r = sub.add_parser("report", help="Markdown report and SHAP figure from a model directory")
    r.add_argument("model")
    r.add_argument("--no-figures", action="store_true")
    f = sub.add_parser("fit", help="the deployable ranker: fit on every labelled site (for the pipeline)")
    f.add_argument("dataset")
    f.add_argument("--out", required=True, help="the models directory (LINKLENS_MODELS_DIR)")
    gf = sub.add_parser("gnn-fit", help="the deployable GraphSAGE model: fit on every site's graphs")
    gf.add_argument("graphs")
    gf.add_argument("--out", required=True, help="the models directory (LINKLENS_MODELS_DIR)")
    s = sub.add_parser("score", help="answer one pipeline scorer request (JSON in, JSON out)")
    s.add_argument("request")
    s.add_argument("--models", required=True)
    s.add_argument("--out", required=True)
    a = p.parse_args(argv)

    if a.cmd in ("fit", "gnn-fit", "score"):
        from . import deploy

        if a.cmd == "score":
            deploy.score(a.request, a.models, a.out)
            return 0
        if a.cmd == "fit":
            d = deploy.fit_ranker(data.load(a.dataset), a.out)
        else:
            from . import gnn

            d = deploy.fit_gnn(gnn.load(a.graphs), a.out)
        print(f"wrote {d} (sha256 {deploy.model_sha256(deploy.model_files(d))})")
        return 0

    if a.cmd == "gnn":
        from . import gnn

        gs = gnn.load(a.graphs)
        metrics = gnn.cross_validate(gs, a.out, a.dataset)
        means = gnn.site_means(metrics)
        print(means.pivot_table(index="site", columns="method", values="mrr").round(3).to_string())
        return 0
    if a.cmd == "gnn-report":
        from . import gnn_report

        print(gnn_report.report(a.gnn, a.ranker, a.ranker_graphsage))
        return 0
    if a.cmd == "train":
        ds = data.load(a.dataset)
        if a.graphsage:
            ds = model.with_graphsage(ds, a.graphsage)
        folds = model.cross_validate(ds, a.out)
        for f in folds:
            s = f.summary
            if s:
                print(
                    f"{f.site.id:20s} MRR learned {s['learned']['mrr']:.3f}  S {s['S']['mrr']:.3f}  "
                    f"hybrid {s['hybrid']['mrr']:.3f}  ({int(s['learned']['queries'])} queries)"
                )
            else:
                print(f"{f.site.id:20s} no E6 queries (predictions only)")
        e8 = model.rating_evaluation(ds, a.out)
        print("E8 ratings: " + ("evaluated" if e8 is not None else "fewer than two rated sites, skipped"))
        print(f"wrote {Path(a.out) / 'predictions'}")
        return 0
    print(report.report(a.model, figures=not a.no_figures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
