"""python -m linklens_analysis report results/*.json  →  Markdown tables on stdout.
python -m linklens_analysis corpus <batch dir> [--policy P3] [--figures <dir>]
    →  the corpus batch compared across architecture classes (and figures, PDF + PNG).
python -m linklens_analysis e1 <batch dir> [--stat median|mean] [--figures <dir>]
    →  E1: every pair of policies per class (summary table, policy × policy heatmaps).
python -m linklens_analysis e2 <batch dir> [--figures <dir>]
    →  E2: each channel's marginal yield per class (table, stacked bar of orphan detection).
python -m linklens_analysis e3 <batch dir> [--measure raw|relative]
    →  E3: LinkLens vs each baseline, paired Wilcoxon across sites, and a table per class.
python -m linklens_analysis e4 <batch dir>
    →  E4: re-crawl stability per class, site change separated from method instability.
python -m linklens_analysis e5 <batch dir>
    →  E5: the Screaming Frog calibration table and every large disagreement explained.
python -m linklens_analysis e6 <batch dir> [--alpha 0.05]
    →  E6: link-masking recovery per method, and the C5 test (hybrid vs cosine).
python -m linklens_analysis e7 <batch dir> [--k 10] [--figures <dir>]
    →  E7: the σ ablation table, the σ pairs' overlap and the ε / α sensitivity curves.
python -m linklens_analysis lsh <lsh run dir> [--variant weighted] [--figures <dir>]
    →  the LSH Ensemble REF pre-filter: recall and runtime against exact REF per page cap.
python -m linklens_analysis make-all <batch dir> [--out <dir>] [--k 10] [--alpha 0.05]
    →  every RQ table (CSV + LaTeX) and figure (PDF + PNG), and a results README (make_all.py)."""

import argparse
import sys

from .results import report

USAGE = """usage: python -m linklens_analysis report <result.json>…
       python -m linklens_analysis corpus <batch dir> [--policy P3] [--figures <dir>]
       python -m linklens_analysis e1 <batch dir> [--stat median|mean] [--figures <dir>]
       python -m linklens_analysis e2 <batch dir> [--figures <dir>]
       python -m linklens_analysis e3 <batch dir> [--measure raw|relative]
       python -m linklens_analysis e4 <batch dir>
       python -m linklens_analysis e5 <batch dir>
       python -m linklens_analysis e6 <batch dir> [--alpha 0.05]
       python -m linklens_analysis e7 <batch dir> [--k 10] [--figures <dir>]
       python -m linklens_analysis lsh <lsh run dir> [--variant weighted] [--figures <dir>]
       python -m linklens_analysis make-all <batch dir> [--out <dir>] [--k 10] [--alpha 0.05]"""


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "report":
        print(report(argv[1:]))
        return 0
    if len(argv) >= 2 and argv[0] == "corpus":
        from . import corpus

        p = argparse.ArgumentParser(prog="python -m linklens_analysis corpus")
        p.add_argument("batch")
        p.add_argument("--policy", default="P3")
        p.add_argument("--figures")
        args = p.parse_args(argv[1:])
        print(corpus.report(args.batch, args.policy))
        if args.figures:
            import matplotlib

            matplotlib.use("Agg")
            written = corpus.figures(corpus.load_batch(args.batch), args.figures, policy=args.policy)
            print(f"{len(written)} figure files written to {args.figures}", file=sys.stderr)
        return 0
    if len(argv) >= 2 and argv[0] == "e1":
        from . import corpus, e1

        p = argparse.ArgumentParser(prog="python -m linklens_analysis e1")
        p.add_argument("batch")
        p.add_argument("--stat", choices=["median", "mean"], default="median")
        p.add_argument("--figures")
        args = p.parse_args(argv[1:])
        print(e1.report(args.batch))
        if args.figures:
            import matplotlib

            matplotlib.use("Agg")
            written = e1.figures(corpus.load_batch(args.batch).pairs, args.figures, stat=args.stat)
            print(f"{len(written)} figure files written to {args.figures}", file=sys.stderr)
        return 0
    if len(argv) >= 2 and argv[0] == "e2":
        from . import corpus, e2

        p = argparse.ArgumentParser(prog="python -m linklens_analysis e2")
        p.add_argument("batch")
        p.add_argument("--figures")
        args = p.parse_args(argv[1:])
        print(e2.report(args.batch))
        if args.figures:
            import matplotlib

            matplotlib.use("Agg")
            written = e2.figures(corpus.load_batch(args.batch).channels, args.figures)
            print(f"{len(written)} figure files written to {args.figures}", file=sys.stderr)
        return 0
    if len(argv) >= 2 and argv[0] == "e3":
        from . import e3

        p = argparse.ArgumentParser(prog="python -m linklens_analysis e3")
        p.add_argument("batch")
        p.add_argument("--measure", choices=list(e3.MEASURES), default="raw")
        args = p.parse_args(argv[1:])
        print(e3.report(args.batch, args.measure))
        return 0
    if len(argv) >= 2 and argv[0] == "e4":
        from . import e4

        print(e4.report(argv[1]))
        return 0
    if len(argv) >= 2 and argv[0] == "e5":
        from . import e5

        print(e5.report(argv[1]))
        return 0
    if len(argv) >= 2 and argv[0] == "e6":
        from . import e6

        p = argparse.ArgumentParser(prog="python -m linklens_analysis e6")
        p.add_argument("batch")
        p.add_argument("--alpha", type=float, default=0.05)
        args = p.parse_args(argv[1:])
        print(e6.report(args.batch, args.alpha))
        return 0
    if len(argv) >= 2 and argv[0] == "e7":
        from . import corpus, e7

        p = argparse.ArgumentParser(prog="python -m linklens_analysis e7")
        p.add_argument("batch")
        p.add_argument("--k", type=int, default=10)
        p.add_argument("--figures")
        args = p.parse_args(argv[1:])
        print(e7.report(args.batch, args.k))
        if args.figures:
            import matplotlib

            matplotlib.use("Agg")
            written = e7.figures(corpus.load_batch(args.batch).e7, args.figures, args.k)
            print(f"{len(written)} figure files written to {args.figures}", file=sys.stderr)
        return 0
    if len(argv) >= 2 and argv[0] == "lsh":
        from . import lsh

        p = argparse.ArgumentParser(prog="python -m linklens_analysis lsh")
        p.add_argument("dir")
        p.add_argument("--variant", choices=lsh.VARIANTS, default="weighted")
        p.add_argument("--figures")
        args = p.parse_args(argv[1:])
        print(lsh.report(args.dir, args.variant))
        if args.figures:
            import matplotlib

            matplotlib.use("Agg")
            written = lsh.figures(args.dir, args.figures, args.variant)
            print(f"{len(written)} figure files written to {args.figures}", file=sys.stderr)
        return 0
    if len(argv) >= 2 and argv[0] == "make-all":
        from .make_all import main as make_all_main

        return make_all_main(argv[1:])
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
