"""Tables as LaTeX (booktabs), written by hand so the output is plain, deterministic and needs no
template engine. Unicode symbols used in the tables (σ, ε, α, Δ, ±, ≥, …) become math commands,
so the files compile with pdfLaTeX without extra packages (booktabs aside)."""

from __future__ import annotations

import math

import pandas as pd

# Tables with more columns than this are scaled down to the line width.
WIDE_COLUMNS = 7

_SPECIAL = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
    "|": r"\textbar{}",
    "<": r"\textless{}",
    ">": r"\textgreater{}",
}
_SYMBOLS = {
    "σ": r"$\sigma$",
    "ε": r"$\varepsilon$",
    "α": r"$\alpha$",
    "λ": r"$\lambda$",
    "ρ": r"$\rho$",
    "ω": r"$\omega$",
    "κ": r"$\kappa$",
    "Δ": r"$\Delta$",
    "±": r"$\pm$",
    "≥": r"$\geq$",
    "≤": r"$\leq$",
    "−": r"$-$",
    "×": r"$\times$",
    "÷": r"$\div$",
    "→": r"$\rightarrow$",
    "·": r"$\cdot$",
    "²": r"$^2$",
    "–": "--",
    "—": "---",
    "…": r"\ldots{}",
    "’": "'",
}


def escape(text: object) -> str:
    """A cell's text for LaTeX: special characters escaped, Unicode symbols as math."""
    s = str(text)
    out = []
    for ch in s:
        if ch in _SPECIAL:
            out.append(_SPECIAL[ch])
        elif ch in _SYMBOLS:
            out.append(_SYMBOLS[ch])
        else:
            out.append(ch)
    return "".join(out)


def cell(value: object) -> str:
    """A value formatted for a table: floats to 3 significant digits, missing as an en dash."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "--"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return escape(f"{value:.3g}")
    return escape(value)


def flat(df: pd.DataFrame) -> pd.DataFrame:
    """The index as leading columns (a MultiIndex becomes one column per level)."""
    if isinstance(df.index, pd.RangeIndex) and df.index.name is None:
        return df.reset_index(drop=True)
    names = [n if n is not None else "" for n in (df.index.names or [None])]
    out = df.copy()
    out.index = out.index.set_names([n or f"level_{i}" for i, n in enumerate(names)])
    return out.reset_index()


def to_latex(df: pd.DataFrame, caption: str, label: str) -> str:
    """A booktabs table (index as leading columns; text left-aligned, numbers right-aligned). A
    table wider than WIDE_COLUMNS is scaled to the line width (`\\resizebox`, graphicx)."""
    t = flat(df)
    cols = [str(c) for c in t.columns]
    align = "".join("r" if pd.api.types.is_numeric_dtype(t[c]) else "l" for c in t.columns)
    wide = len(cols) > WIDE_COLUMNS
    lines = [
        r"\begin{table}[t]",
        r"\centering",
        r"\small",
        rf"\caption{{{escape(caption)}}}",
        rf"\label{{{label}}}",
        *([r"\resizebox{\linewidth}{!}{%"] if wide else []),
        rf"\begin{{tabular}}{{{align}}}",
        r"\toprule",
        " & ".join(escape(c) for c in cols) + r" \\",
        r"\midrule",
    ]
    for _, row in t.iterrows():
        lines.append(" & ".join(cell(v) for v in row.tolist()) + r" \\")
    lines += [r"\bottomrule", r"\end{tabular}" + ("}" if wide else ""), r"\end{table}", ""]
    return "\n".join(lines)
