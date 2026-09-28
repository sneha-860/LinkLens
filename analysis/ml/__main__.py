"""python -m ml train <dataset dir> --out <model dir> | report <model dir>"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import data, model, report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m ml")
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train", help="leave-one-site-out LightGBM lambdarank + TreeSHAP")
    t.add_argument("dataset")
    t.add_argument("--out", required=True)
    r = sub.add_parser("report", help="Markdown report and SHAP figure from a model directory")
    r.add_argument("model")
    r.add_argument("--no-figures", action="store_true")
    a = p.parse_args(argv)

    if a.cmd == "train":
        ds = data.load(a.dataset)
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
