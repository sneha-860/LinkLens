# LinkLens

LinkLens is an internal link auditor. It crawls a public site politely, finds orphan pages by
reconciling six discovery channels, measures the link graph, diagnoses each link with a semantic
layer, and recommends new or more visible links, ranked by the PageRank they would add to the
pages that need it. Every recommendation comes with a rule-based explanation and a suggested
anchor.

- **Polite crawling:** robots.txt (RFC 9309) is checked before every request, requests to a host
  are spaced by max(500 ms, its Crawl-delay), the User-Agent names a contact URL, and at most
  500 pages are crawled.
- **Reproducible:** raw observations are stored as observed and never changed. Every result is
  a versioned artefact tied to its run and canonicalisation policy (P0–P5), and all randomness is
  seeded.
- **Explained:** fixes carry the evidence behind them: the matched terms, the PageRank gain, the
  editing effort and where the link would go.

## Documentation

| Document                                     | What it covers                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The 21-stage pipeline (Mermaid), what each package does, runtime processes, data flow                                    |
| [docs/METHODS.md](docs/METHODS.md)           | Formal definitions: P0–P5, REF, ε, ρ, ω, the four cases, σ, S, κ, with the adaptations of Belezko & McGoey (2023) marked |
| [docs/EVALUATION.md](docs/EVALUATION.md)     | Protocols of experiments E1–E8 and the corpus runner                                                                     |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md)   | What the results cannot claim: prominence is not popularity, the 500-page cap, the weight choices, English-only text     |
| [CLAUDE.md](CLAUDE.md)                       | The authoritative implementation spec                                                                                    |

## Prerequisites

- Node.js 22+ (see `.nvmrc`) and pnpm 9 (`npm install -g pnpm@9`, or `corepack enable`)
- Docker Desktop, for Postgres 16 and Redis 7
- Python 3.11+, only for `analysis/` (statistics, figures and the optional ML models)

## Quick start

```sh
pnpm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm services:up              # Postgres on localhost:5433, Redis on localhost:6379
pnpm db:migrate
pnpm demo                     # audit the bundled fixture site end to end
```

### The demo: an audit of the fixture site

`pnpm demo` serves the crawler's test site (`packages/crawler/test/fixtures/site`) on
`http://127.0.0.1:4010`. It then audits it through the same 21-stage pipeline the API uses,
under policy P3, and prints the result. The fixture site is small, but it has what an audit looks
for:

- orphans that only a sitemap, feed, HTML sitemap or `llms.txt` reveals;
- a redirect chain, a redirect loop and a broken link;
- a deep chain of pages;
- nofollow links;
- a robots.txt with disallowed paths and a 20 ms Crawl-delay.

The first run downloads the MiniLM embedding model (about 90 MB) into `.cache/linklens`. After
that it is cached. A run takes about a minute; the crawl is spaced by the default 500 ms delay.

```text
$ pnpm demo
[0.0s] fixture site at http://127.0.0.1:4010/ (robots.txt allows LinkLensBot, Crawl-delay 20 ms)
[0.3s] audit 1 started (policy P3, the default; 21 stages)
[26.3s] crawl done (25931 ms)
[27.9s] extract done (1644 ms)
[37.3s] discovery done (9326 ms)
…
[57.9s] embeddings done (20113 ms)
…
[60.9s] counterfactual done (2498 ms)
…
[61.1s] scoring done (167 ms)
[61.2s] importance done (73 ms)
[61.3s] learnedScore skipped: no ranker model at .cache\linklens\scoring-models\ranker\model.json (python -m ml fit)
[61.3s] graphsageScore skipped: disabled
[65.9s] rescue done (4646 ms)
[66.2s] explanations done (250 ms)

Audit 1 of http://127.0.0.1:4010/ — completed in 65.5 s of stage time
  pages crawled      20
  link graph         31 nodes, 65 links, 30 reachable from the home page
  discovery          35 URLs known, 5 orphans (found only outside the link graph)
  issues             23 (orphan 5, dead-end 5, deep-page 3, weak-authority 1, outside-largest-scc 6, noindex-nofollow-conflict 3)
  diagnosis          v4 missing 37, v3 buried 2, v2 good 10, v1 misleading 18
  fixes ranked       45

Top 5 fixes by S = ΔPR × σ / κ:
  1. Add a link from /only-from-nofollow-page.html to /nofollow-target.html: the target is missing a link from 3 related pages (v4); REF 0.24 on 'nofollow', 'page'; anchor 'nofollow' in paragraph 1; predicted PageRank +3.33e-2 (+170.0%); κ 1.
  2. Add a link from /deep/6.html to /deep/5.html: the target is 5 clicks from the home page (deeper than 3); REF 0.60 on 'depth', 'home'; predicted PageRank +1.41e-2 (+49.8%); κ 1.
  3. Add a link from /deep/2.html to /deep/1.html: the target is missing a link from 5 related pages (v4); REF 0.83 on 'depth', 'deeper'; predicted PageRank +1.09e-2 (+26.1%); κ 1.
  4. Add a link from /deep/1.html to /deep/5.html: the target is 5 clicks from the home page (deeper than 3); REF 0.83 on 'depth', 'deeper'; predicted PageRank +1.15e-2 (+40.7%); κ 1.
  5. Add a link from /deep/3.html to /deep/2.html: the target is missing a link from 5 related pages (v4); REF 0.83 on 'depth', 'deeper'; predicted PageRank +9.93e-3 (+29.2%); κ 1.

Explore it in the dashboard: pnpm start, then open http://localhost:3001/audits/1/summary
```

`learnedScore` reports "skipped" until you train a ranker (see [Optional models](#optional-models)),
and `graphsageScore` is off unless an audit turns it on. That is expected: the audit still
completes. Timings and the audit id differ from run to run; the findings do not, since the site
and every random choice are fixed.

Then look at the same audit in the dashboard:

```sh
pnpm start                    # builds the web app, serves API + dashboard on http://localhost:3001
```

Open the link the demo printed (`/audits/<id>/summary`). The tabs show:

- **Graph:** click a node for its metrics, page type and importance.
- **Fixes:** switch the scoring mode; click a row for its explanation and suggested anchor.
- **Diagnosis:** the v1–v4 cases and the ρ/ω scatter.
- **Orphans:** each URL × channel, and the rescue donors.
- **Links:** broken links and redirect chains.
- **Canonicalisation:** P0–P5 compared.

Run `pnpm demo --keep` to keep the fixture site running afterwards, so the dashboard's page links
still open.

### Audit your own site

In the dashboard, choose **New audit**, or use the API:

```sh
curl -X POST http://localhost:3001/api/audits -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/", "pageCap": 200, "policy": "P3"}'
```

- **User-Agent.** Before crawling a site you do not own, set `LINKLENS_USER_AGENT` in `.env` to
  your own crawler name with a contact page, e.g.
  `MyAuditBot/1.0 (+https://example.org/about-this-crawler)`. A User-Agent without a product
  token, a version and an `https://` contact is refused.
- **Overrides.** Per-audit config overrides may make crawling slower or smaller, never faster or
  larger.
- **API.** The OpenAPI document is at `/api/openapi.json` and Swagger UI at `/api/docs`.
- **Authentication.** Set `LINKLENS_API_KEY` to require a key; the dashboard then asks for it
  once.

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test                     # unit tests (no Docker needed)
pnpm test:integration         # database, Redis and end-to-end tests (Docker must be running)
pnpm format
pnpm --filter @linklens/api dev   # API with reload on http://localhost:3001
pnpm --filter @linklens/web dev   # dashboard on http://localhost:5173 (/api proxied to 3001)
```

**Database.**

- Migrations are plain SQL in `packages/db/migrations`, run by node-pg-migrate.
- Schema changes are always new migrations: `pnpm --filter @linklens/db migrate:create <name>`.
  Never edit an applied migration.
- `pnpm db:rollback` undoes the last one.
- `link_observations`, `discovery_observations`, `fetch_bodies`, `analytics_clicks` and
  `fix_ratings` are append-only: triggers reject `UPDATE`, `DELETE` and `TRUNCATE`.
- `pnpm services:down` stops the services; data persists in Docker volumes, so add `-v` to wipe.

**Rules of the codebase.**

- `packages/core` does no I/O.
- Every threshold lives in `packages/core/src/config.ts`.
- A stage's version is bumped whenever its output can change.
- Every module has unit tests.

See [CLAUDE.md](CLAUDE.md).

## Python analysis

```sh
cd analysis
python -m venv .venv
.venv\Scripts\activate            # Windows; macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

Corpus results: `python analysis/make_all.py results/corpus/<batch>` writes every table and figure
of E1–E7 (see [docs/EVALUATION.md](docs/EVALUATION.md)).

### Optional models

The learned prioritiser and GraphSAGE are trained on a corpus batch, then used by audits:

```sh
pip install -e ".[ml]"                     # LightGBM; add ".[gnn]" for GraphSAGE (PyTorch)
pnpm --filter @linklens/eval l13 export --batch <b>
python -m ml fit results/corpus/<b>/l13/dataset --out .cache/linklens/scoring-models
```

The pipeline finds the models in `LINKLENS_MODELS_DIR` (default
`.cache/linklens/scoring-models`), using `LINKLENS_PYTHON` (default `analysis/.venv`).

## Layout

```
packages/
  core/            pure algorithms (no I/O); src/config.ts holds every threshold
  db/              pg pool, SQL migrations, schema tests
  crawler/         robots.txt, per-host throttle, crawl orchestrator, extraction, discovery, rescue
  embeddings/      MiniLM embeddings in a worker thread, with a disk cache
  counterfactual/  fix simulation in worker threads
  api/             pipeline runner, HTTP API, the demo
  web/             React + Vite dashboard
  eval/            experiments E1–E8, corpus runner, L13/GraphSAGE exports
analysis/          Python statistics, figures and ML (outside the pnpm workspace)
docs/              architecture, methods, evaluation, limitations
```

## Scripts

| Command                              | What it does                                           |
| ------------------------------------ | ------------------------------------------------------ |
| `pnpm demo`                          | Audit the fixture site end to end and print the result |
| `pnpm start`                         | Build the dashboard and serve it with the API on :3001 |
| `pnpm test` / `test:integration`     | Unit tests / tests against Postgres and Redis          |
| `pnpm typecheck` / `lint` / `format` | `tsc --noEmit`, ESLint, Prettier                       |
| `pnpm services:up` / `services:down` | Start / stop Postgres and Redis                        |
| `pnpm db:migrate` / `db:rollback`    | Apply / roll back migrations                           |
