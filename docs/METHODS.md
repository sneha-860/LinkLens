# Methods

Formal definitions of what LinkLens computes. Defaults are those of
`packages/core/src/config.ts`, where every threshold lives; each run stores the config it used.
The architecture is in [ARCHITECTURE.md](ARCHITECTURE.md), the experiments in
[EVALUATION.md](EVALUATION.md), and what the methods cannot claim in
[LIMITATIONS.md](LIMITATIONS.md).

**Source and adaptations.** The semantic layer (the REF measure and the four-case diagnosis)
follows US Patent 11,586,824 B2 (Belezko & McGoey, 2023). Wherever LinkLens departs from it, the
text says so in a block marked **Adaptation**. Everything not attributed to the patent
(canonicalisation, the graph metrics, fix simulation and ranking, κ, σ and S) is LinkLens's own.

## Notation

| Symbol | Meaning                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| V      | the nodes of a link graph under a policy: canonical URLs of the seed, crawled pages and internal link targets |
| u, v   | a donor page (would carry the link) and a target page (would receive it)                                      |
| E(u,v) | the link observations from u's representative page to v (a multiset: one per `<a href>`)                      |
| D      | the documents: nodes whose representative page was fetched as 2xx HTML                                        |
| N      | \|V\|, or \|D\| where the text model is concerned                                                             |
| ε      | the REF cutoff, `epsilon` = 0.2                                                                               |
| α      | the diagnosis threshold, `alpha` = 0.1                                                                        |
| d      | the PageRank damping factor, `pagerankDamping` = 0.85                                                         |

## 1. Canonicalisation policies P0–P5

A policy is a pure function Pₖ : (url, context) → node id, where the node id is a canonical URL
string. Raw URLs are stored as observed and projected at read time. Each policy adds one step to
the previous one, so Pₖ₊₁(x) is a function of Pₖ(x): two URLs merged by Pₖ stay merged by Pₖ₊₁.
This monotone coarsening is tested.

| Policy | Pₖ(x) is Pₖ₋₁(x) plus                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0     | RFC 3986 §6.2.2–6.2.3 normalisation: lower-case scheme and host; percent-encoding normalised (unreserved characters decoded, hex upper-cased, non-URI characters UTF-8 encoded); dot-segments removed; default or empty port dropped; an empty http(s) path becomes `/`. |
| P1     | drop the fragment; strip trailing slashes from the path, except the root `/`.                                                                                                                                                                                            |
| P2     | drop tracking parameters (`utm_*`, `mc_*`, `gclid`, `fbclid`, `ref`; names matched case-insensitively) and empty parameters; stable-sort the remaining parameters by name; drop an empty query.                                                                          |
| P3     | drop the query; treat `http`/`https` and `www.`/bare host as one host, written as `https://` without `www.`.                                                                                                                                                             |
| P4     | follow recorded redirects on the P3 node graph: a node maps to the end of its redirect chain; a redirect loop maps to its smallest node.                                                                                                                                 |
| P5     | follow `rel=canonical` (RFC 6596) hop by hop on the P4 graph, while the target is same-site (the P3 host) and was fetched 2xx. A cycle stops at its entry node; a chain longer than `canonicalMaxHops` (3) is not trusted, and the page keeps its P4 node.               |

Redirect and canonical evidence comes from the crawl's own fetches. When observations conflict,
the most frequent target wins, and ties go to the smallest target, which keeps the result
deterministic. Each policy has a version (`P3@1.0.0`) that every derived artefact records.

## 2. Link graph and structural metrics

The graph is a directed multigraph with one edge per link observation. Self-loops are dropped but
counted, and external and non-http links are left out. When a policy merges pages, a node's
out-links come from its earliest-fetched page, its **representative**.

- **PageRank.** Power iteration over the multigraph, weighted by edge multiplicity w(u→v) = |E(u,v)|:

  PR(v) = (1 − d)/N + d·Σ_u PR(u)·w(u→v)/W(u) + d·Σ_{u dangling} PR(u)/N

  where W(u) = Σ_v w(u→v), and a dangling node (no out-links) spreads its rank uniformly. It
  iterates until the L1 change is below `pagerankTolerance` (10⁻¹⁰), or at most
  `pagerankMaxIterations` (1,000) times.

- **Depth.** BFS distance from the seed (null if unreachable).
- **SCCs.** Strongly connected components, by Tarjan's algorithm.
- **Betweenness.** Brandes' algorithm, unweighted and directed. It's exact up to 300 nodes, and
  above that it samples 100 seeded sources, scaled by N/k.

**Orphans.** Six discovery channels each produce observations: the link graph, XML sitemaps at
conventional paths, sitemaps declared in robots.txt, HTML sitemap pages, RSS/Atom feeds, and
llms.txt. Each URL is mapped through the policy. A node is an **orphan** when some non-link
channel reports it but it is not reachable from the seed in the link graph. The provenance of
each channel is kept.

## 3. Text representation

For each document v ∈ D there are three fields:

- **Title(v):** `<title>` and `<h1>`.
- **Links(v):** the anchor texts of v's own out-links in the main content (`dom_region` main or
  body).
- **Body(v):** the main-content text, with navigation, header, footer, aside, breadcrumb and
  pagination stripped.

**Tokenising.** Text is NFKC-normalised, lower-cased, and apostrophes inside words are removed.
It is split into phrases at punctuation. Numbers, English stop-words and tokens shorter than 2
characters are dropped; a dropped stop-word does not break a phrase. The remaining words are
Porter-stemmed, and unigrams and bigrams are formed within a phrase. N-grams never cross a phrase
or a field boundary.

**Boilerplate.** Document frequency df(t) is counted over the site, in any field. The top 7% of
n-grams by df are dropped, but only those in at least max(2, ⌈0.5·N⌉) documents, so a topic
shared by a few pages survives.

**Weights.** Each field f gets TF-IDF weights: tf_f(t, v) is the raw count, and
idf(t) = ln((1 + N)/(1 + df(t))) + 1. Two views are formed:

- the donor view S_A(u) = terms(Links(u)) ∪ terms(Body(u));
- the target view S_B(v) = terms(Title(v)) ∪ terms(Body(v)), with v's own anchors excluded.

A term's view weight w_B(t; v) is the sum of its field TF-IDF weights over the view's fields.

## 4. REF, ε and ρ

**REF: directional containment of the target in the donor.**

- Weighted (the default):
  REF(u, v) = Σ_{t ∈ S_A(u) ∩ S_B(v)} w_B(t; v) / Σ_{t ∈ S_B(v)} w_B(t; v)
- Unweighted: REF(u, v) = |S_A(u) ∩ S_B(v)| / |S_B(v)|

REF is asymmetric: it asks how much of what v is about is also on u.

> **Adaptation.** Belezko & McGoey (2023) define the unweighted containment. LinkLens weights the
> intersection by the target's TF-IDF view weights, which reduces the unweighted form's bias
> towards short targets (for a two-term target, one shared word already gives 0.5). It also
> computes REF over field-aware, site-specific TF-IDF token sets with the site's boilerplate
> removed. The patent's unweighted form is kept as the `unweighted` variant for the σ ablation
> (E7).

**ε cutoff.** Only REF(u, v) > ε (0.2) is stored; smaller values are set to 0. Self-pairs are
never stored. The matrix is computed exactly for all ordered pairs, through an inverted index.
An optional LSH Ensemble pre-filter (off by default) trades recall for speed on large sites.

**Per-node normalisation ρ.** For each donor u with stored entries,

ρ(u, v) = REF(u, v) / Σ_{w : REF(u,w) > ε} REF(u, w)

so each donor's ρ values sum to 1: ρ says how much of u's topical overlap goes to v.

> **Adaptation.** The ε cutoff and the per-donor normalisation are LinkLens's. They make the
> relevance scale comparable across donors with very different amounts of text.

## 5. Prominence ω

How visibly u links to v, from where the links sit in the page:

- W(u, v) = Σ_{o ∈ E(u,v)} r(o) · p(o) · s(o)
- **Region weight r(o)**, by `dom_region` class: body 1.0 (main, body or none), breadcrumb 0.5,
  aside 0.4, header 0.3, nav 0.3, pagination 0.2, footer 0.1.
- **Position factor p(o)** = 1/(1 + 0.1·rank) for body links, where rank counts the page's body
  links in document order (external links included, starting at 0). Other regions get 1.
- **Site-wide discount s(o)** = 0.3 when the link's `template_signature` is on more than 50% of
  representative pages, else 1.

Normalised, ω(u, v) = W(u, v) / Σ_x W(u, x), or 0 when u's total is 0. When analytics clicks are
imported, a source node with clicks on any edge uses clicks as W for all its edges; that
analytics mode feeds diagnosis, never the counterfactual.

> **Adaptation.** The patent's link popularity is session-based: it uses how often visitors
> follow a link. LinkLens has no sessions, so ω is a **structural prominence** proxy, following
> the reasonable-surfer idea that placement predicts use. It is always called prominence, never
> popularity: it measures where a link sits, not how often it is clicked. The region weights,
> decay, site-wide share and discount are our assumptions, not fitted to clicks (see
> LIMITATIONS.md).

## 6. The four-case diagnosis

A pair (u, v), u ≠ v, is judged when both are documents and REF(u, v) > ε or a link u→v exists.
Here ρ = 0 when REF ≤ ε, and ω = 0 without a link. With threshold α:

| Case | Label                | Rule               | Recommendation             |
| ---- | -------------------- | ------------------ | -------------------------- |
| v4   | missing              | ρ > α, no link     | add a link                 |
| v3   | buried               | ρ > α, link, ω < α | make the link more visible |
| v2   | good                 | ρ > α, ω ≥ α       | none                       |
| v1   | misleading/low-value | ρ ≤ α, ω ≥ α       | flag for review or removal |
| —    | unclassified         | ρ ≤ α, ω < α       | none                       |

The severity of a case is |ω − ρ|. Diagnoses are ordered by case (v4, v3, v1, v2), then by
severity, highest first. Only v4 and v3 lead to simulated fixes; v1 is flagged, never simulated.
Links to or from a node without text are counted as `skippedNoText`, not judged.

> **Adaptation.** The four-case logic (relevant but unlinked, relevant but buried, relevant and
> prominent, prominent but irrelevant) is from Belezko & McGoey (2023). LinkLens puts
> **prominence ω** where the patent has session popularity. It uses one threshold α (0.1) for
> both axes, applied to normalised ρ rather than raw REF, and adds the severity ordering and the
> never-simulated rule for v1.

## 7. Fixes

### 7.1 Targets and admissible donors

Targets are the structural audit's orphans, deep pages (depth > 3) and weak-authority pages (below
the 20th PageRank percentile), plus the targets of v4/v3 diagnoses. A donor u is admitted for
target v when all of these hold, in order:

1. u is a same-site page with text, and u ≠ v;
2. u is not a utility page (login, cart, account, search, tag archive; `candidateUtilityPatterns`);
3. the sections are compatible: the same, siblings, or one of them top level. A section is the
   first path segment when a path has at least 2 segments;
4. REF(u, v) > ε;
5. the action is determined: **add-link** if there is no body link u→v (a chrome-only link counts
   as none), **make-visible** if a body link has ω(u, v) < α. A body link with ω ≥ α is already
   prominent, so there is nothing to do.

At most 30 donors are kept per target, by REF.

### 7.2 Counterfactual ΔPR

For each candidate, a copy of the graph weighted by structural W gets the link u→v set to the
body weight 1.0. For make-visible, an existing link is raised to 1.0, never lowered. PageRank is
recomputed with the same formula as in §2, over weights W instead of multiplicities,
warm-started from the baseline vector. Then:

- ΔPR_v = PR′(v) − PR(v), the target's gain;
- the site-wide Σ|ΔPR|;
- depth_v before and after (null if unreachable).

A seeded sample of candidates is re-run from a cold start, and must agree within the tolerance.

### 7.3 σ: how related the pages are

cos(u, v) is the cosine similarity of the two pages' embeddings (MiniLM, L2-normalised). The input
is the title, then the first 256 tokens of the body. A missing cosine counts as 0.

| Variant                             | σ(u, v)                                  |
| ----------------------------------- | ---------------------------------------- |
| `cosineOnly`                        | cos(u, v)                                |
| `refOnly`                           | REF(u, v)                                |
| `refGateCosine` (σ_hybrid, default) | cos(u, v) if REF(u, v) > ε, else 0       |
| `blended`                           | λ·REF(u, v) + (1 − λ)·cos(u, v), λ = 0.5 |

Every fix records all four; `sigmaVariant` chooses the one that scores.

### 7.4 κ: editing effort

κ(u) is the number of distinct template signatures among u's body-region link observations, at
least 1. A page whose body links sit in one block costs 1, and each further block costs 1 more.
Unsigned links (directly under `<body>`) are ignored. `templateReach(u)` is the largest number of
pages that carry one of u's body blocks, and is used in explanations.

### 7.5 The score S

S(u→v) = ΔPR_v × σ(u, v) / κ(u)

Fixes are ordered by S (highest first), then ΔPR_v, donor and target. A negative cosine gives a
negative S, which ranks last. `rank` is global, and `targetRank` is the rank among a target's own
donors. The optional **S_imp** mode multiplies S by the target's importance (§10).

### 7.6 Orphan rescue

Orphans are never crawled, so they have no text in the site model. Rescue fetches each orphan's
first raw URL once (politely, capped by `rescueMaxFetches`). It weights the orphan's
Title ∪ Body against the unchanged site model: the site's IDF, its boilerplate list, and the
df = 0 IDF for unseen terms. Donors are admitted as in §7.1, and must also be reachable from the
home page. The best 30 by REF are shortlisted. Each shortlisted donor → orphan link is simulated
as in §7.2 on the graph plus the orphan nodes, and the top `rescueTopK` (5) by ΔPR are reported.

## 8. Explanations and anchor suggestions

Every fix, rescue donor and diagnosis gets a rule-based explanation from fixed templates, with
fixed number formats, so the same evidence always gives byte-identical text. It covers:

- why the target needs a link (orphan and its channels, depth, weak authority, v4/v3);
- the donor evidence (REF, the top matched n-grams in their written form, cosine);
- the existing link and its regions;
- the impact (PR before and after, Δdepth) and the effort (κ, template reach).

**Where to put the link** comes from the patent's element-level REF, applied to paragraphs:

REF(p, Title(v)) = Σ_{t ∈ S_p ∩ T_v} w_T(t) / Σ_{t ∈ T_v} w_T(t)

S_p is the n-grams of a donor paragraph (`<p>`/`<li>`), with text u already links removed, and
T_v is the target's Title-field weights. The best paragraph is used if its REF > ε. The anchor is
its matched n-gram with the largest title weight, quoted verbatim from the paragraph.

## 9. Structural audit and page importance

The audit's issue rules are:

- **orphan:** high severity if a sitemap lists it;
- **deep page:** depth > 3; high if > 6;
- **weak authority:** below the 20th PageRank percentile; high if below the 5th;
- **outside the largest SCC;**
- **dead end;**
- **noindex/nofollow conflicts.**

Page importance (optional, L12) is a weighted mean in [0, 1]:

importance(v) = 0.4·prior(type(v)) + 0.25·PRpct(v) + 0.2·1/(1 + depth(v)) + 0.15·ln(1 + in_body(v))/ln(1 + max in_body)

- **type(v):** a rule-based page type (homepage, hub, product, article, utility, other), decided
  by, in order: the seed, utility URLs, schema.org types, URL patterns, then structure.
- **PRpct(v):** v's mid-rank PageRank percentile.
- The depth term is 0 when v is unreachable.

The weights are heuristic (see LIMITATIONS.md). Then S_imp(u→v) = S(u→v) × importance(v).

## 10. Optional learned layers

These reorder or annotate fixes. S stays the default, and the rule-based explanation stays the
explanation of record.

**Learned prioritiser (L13).**

- **Labels** come from E6's hide-and-recover (EVALUATION.md). Each masked link u*→v is a query:
  u* is the one positive, and v's other admissible candidates are negatives. Every feature is
  measured in the masked site.
- **Features:** ΔPR, depth gain, newly reachable, REF, cosine, term Jaccard, ω of an existing
  link, κ, template reach, both pages' PageRank, depth, in/out neighbours, largest-SCC
  membership, importance and page type, and whether they share a section.
- **Model:** LightGBM lambdarank with a fixed seed, on one thread. A fix's priority is its raw
  score's mid-rank percentile among the site's fixes.
- **Evaluation** is leave-one-site-out. For audits, a deployable model is fit on every labelled
  site (`python -m ml fit`), and in-sample scores are flagged (`seenSite`).
- **Explanations:** TreeSHAP gives each fix its three largest contributions.

**GraphSAGE (off by default).**

- **Graph:** undirected message passing over body links, with the embedding plus structural node
  features as input.
- **Model:** 2 SAGEConv layers (mean aggregator) and a directed MLP decoder, trained with BCE
  against sampled non-edges, leave-one-site-out on the E6 masked graphs.
- **Use:** its logit is shown on each fix, not used to rank.

**Running them.** The model stages call `python -m ml score` once each (protocol
`linklens-scorer@1`). A missing model, interpreter or package skips the stage and never fails
the audit. Every artefact records the model's SHA-256, and the corpus manifest records the
models' file hashes.

## Reference

Belezko & McGoey (2023). US Patent 11,586,824 B2. The source of the REF directional-containment
measure, element-level REF and the four-case relevance × popularity logic that LinkLens adapts
as marked above.
