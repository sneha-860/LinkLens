# LinkLens

LinkLens is an internal link auditor. It crawls a public site, reconciles six discovery channels to find
orphan pages, computes graph metrics, adds a semantic layer that diagnoses each link, and ranks
simulated link fixes. The full spec is in [CLAUDE.md](CLAUDE.md).

> Status: scaffold only. Features are not implemented yet.

## Prerequisites

- Node.js 22+ (24 recommended, see `.nvmrc`)
- pnpm 9: `npm install -g pnpm@9` (or `corepack enable` from an admin shell)
- Python 3.11+ (for `analysis/` only)
- Docker Desktop (for Postgres 16 and Redis 7)

## Setup

```sh
pnpm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm services:up              # Postgres on localhost:5433, Redis on localhost:6379
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test                     # unit tests (no Docker needed)
pnpm test:integration         # DB integration tests (Docker must be running)
```

## Database

- Migrations are plain SQL in `packages/db/migrations`, run by node-pg-migrate.
  - New migration: `pnpm --filter @linklens/db migrate:create <name>`
  - Apply: `pnpm db:migrate`. Roll back one: `pnpm db:rollback`.
- `link_observations` and `discovery_observations` are append-only: triggers reject UPDATE, DELETE
  and TRUNCATE.
- Stop services with `pnpm services:down` (data persists in Docker volumes; add `-v` to wipe).

## Running

```sh
pnpm --filter @linklens/api dev   # API on http://localhost:3001  (GET /health)
pnpm --filter @linklens/web dev   # UI on http://localhost:5173  (/api proxied to the API)
```

## Python analysis

```sh
cd analysis
python -m venv .venv
.venv\Scripts\activate            # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -e ".[dev]"
pytest
```

## Layout

```
packages/
  core/      pure algorithms, no I/O; src/config.ts holds every threshold; src/db typed queries
  db/        pg pool, SQL migrations, DB integration tests
  crawler/   robots.txt-compliant crawler, append-only raw observations
  api/       Express HTTP API
  web/       React + Vite UI
  eval/      evaluation experiments E1–E8
analysis/    Python statistics (outside the pnpm workspace)
```

## Scripts

| Command                              | What it does                        |
| ------------------------------------ | ----------------------------------- |
| `pnpm test`                          | Vitest across all packages          |
| `pnpm typecheck`                     | `tsc --noEmit` in every package     |
| `pnpm lint`                          | ESLint (flat config)                |
| `pnpm format`                        | Prettier write                      |
| `pnpm build`                         | Build every package                 |
| `pnpm test:integration`              | DB integration tests (needs Docker) |
| `pnpm services:up` / `services:down` | Start/stop Postgres + Redis         |
| `pnpm db:migrate` / `db:rollback`    | Apply / roll back migrations        |
