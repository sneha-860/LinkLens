import type { RawDocument } from "./model.js";
import { wordPhrases, type TokeniseOptions } from "./tokenise.js";

type Counts = Map<string, Map<string, number>>;

function add(counts: Counts, term: string, surface: string): void {
  let forms = counts.get(term);
  if (forms === undefined) counts.set(term, (forms = new Map()));
  forms.set(surface, (forms.get(surface) ?? 0) + 1);
}

/** Most frequent first; a tie goes to the shorter form, then the smaller string. */
function best(forms: ReadonlyMap<string, number>): string | undefined {
  let out: string | undefined;
  let n = 0;
  for (const [form, c] of forms) {
    if (
      out === undefined ||
      c > n ||
      (c === n && (form.length < out.length || (form.length === out.length && form < out)))
    ) {
      out = form;
      n = c;
    }
  }
  return out;
}

/**
 * The words behind stemmed terms, for explanations: "run shoe" was written "running shoes".
 * Only the terms asked for are counted, in every field of every document (title, link anchors,
 * body), so the table stays small. Pure and deterministic.
 */
export class SurfaceForms {
  private readonly byNode = new Map<string, Counts>();
  private readonly site: Counts = new Map();

  constructor(
    documents: readonly RawDocument[],
    terms: ReadonlySet<string>,
    opts: TokeniseOptions,
  ) {
    if (terms.size === 0) return;
    for (const doc of documents) {
      const counts: Counts = new Map();
      for (const text of [...doc.title, ...doc.links, ...doc.body]) {
        for (const words of wordPhrases(text, opts)) {
          for (let n = 1; n <= opts.maxNgram; n++) {
            for (let i = 0; i + n <= words.length; i++) {
              const slice = words.slice(i, i + n);
              const term = slice.map((w) => w.stem).join(" ");
              if (!terms.has(term)) continue;
              const surface = slice.map((w) => w.surface).join(" ");
              add(counts, term, surface);
              add(this.site, term, surface);
            }
          }
        }
      }
      if (counts.size > 0) this.byNode.set(doc.node, counts);
    }
  }

  /**
   * How `term` was written: its most frequent form in the first of `nodes` that uses it (so
   * the target's own words come first when it is listed first), else across the site, else the
   * stem itself.
   */
  of(term: string, nodes: readonly string[] = []): string {
    for (const node of nodes) {
      const forms = this.byNode.get(node)?.get(term);
      if (forms !== undefined) return best(forms) ?? term;
    }
    const forms = this.site.get(term);
    return forms === undefined ? term : (best(forms) ?? term);
  }
}
