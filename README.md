# Aquilla

A browser-first collaborative Bible-translation workspace. Bilingual experts
translate scripture cell-by-cell (source ↔ target) with AI completion, terminology
management, audio/oral translation, back-translation, comments, and org-level
oversight for managers who don't read the target language. First users are Paratext
consultants — USFM/Paratext import-export fidelity is a hard requirement.

## Stack

| Layer | Tech |
|---|---|
| SPA | React 19 + Vite 8, TypeScript, Tailwind 4, shadcn/base-ui |
| Edge router | Cloudflare Worker (`worker/`) — selects marketing vs app HTML |
| Identity | Cloudflare Worker (`auth-worker/`) — Hono, Neon Postgres via Hyperdrive |
| Sync | Cloudflare Worker (`sync-worker/`) — event log + projection writer + ProjectSync DO |
| Data | Neon Postgres (live); Docker `postgres:16` locally |
| Media | Cloudflare R2 (audio blobs) |
| Desktop | Tauri shell (`src-tauri/`) |

Architecture: event-sourced CQRS. Client → IndexedDB outbox → `POST /events` →
sync-worker projects into `cells`/`files` tables → ProjectSync DO broadcasts to
WebSocket clients. See [AGENTS.md](AGENTS.md) for details.

## Fresh-clone setup

Three `pnpm install` runs are required — root, auth-worker, and sync-worker each have
their own `node_modules`:

```bash
pnpm install
pnpm --dir auth-worker install
pnpm --dir sync-worker install
```

Copy the env template and fill in your secrets:

```bash
cp .env.example .env.local
```

**Docker must be running.** `pnpm dev` spins a `postgres:16` container named
`aquilla-dev-pg` on port 5432 and applies the schema automatically on first boot.

## Running locally

```bash
pnpm dev        # starts auth-worker (8788) + sync-worker (8789) + Vite (5173)
```

The script (`scripts/dev-stack.ts`) wires `VITE_AUTH_BASE` / `VITE_SYNC_WORKER_HOST`
/ `VITE_CHAT_BASE` to the local worker ports automatically.

Dev login bypass: navigate to `http://127.0.0.1:5173/__dev/login` — seeds a `dev`
user and redirects to `/project/dev-project`.

## Tests

```bash
pnpm test                # unit tests (vitest)
pnpm test:e2e:smoke      # smoke suite — runs serially, ~40-60 min; also runs on git push
pnpm test:e2e            # full Playwright suite (requires Docker)
```

> **Note:** the smoke suite has outgrown its original "<2 min" design — nearly
> every spec is tagged `.smoke.spec.ts` and they run with `workers: 1`, so a
> full smoke pass takes ~40-60 minutes (audit TEST-3). Budget accordingly
> before pushing; see [e2e/README.md](e2e/README.md) for details.

> **Warning:** `pnpm test:e2e` (via `scripts/e2e-up.ts`) force-kills whatever is on
> ports 5173, 8787, and 8788. Do not run it while your live dev stack is active.
> See [e2e/README.md](e2e/README.md) for full setup instructions.

Worker test suites (run separately, each uses PGlite — no Docker needed):

```bash
cd auth-worker  && pnpm test
cd sync-worker  && pnpm test
```

## Deploy scripts

Scripts follow the pattern `pnpm run deploy:<brand>:<target>`:

| Command | What it does |
|---|---|
| `pnpm run deploy:aquilla` | Build SPA + deploy all three workers to production |
| `pnpm run deploy:aquilla:spa` | SPA only |
| `pnpm run deploy:aquilla:auth` | auth-worker only |
| `pnpm run deploy:aquilla:sync` | sync-worker only |
| `pnpm run deploy:aquilla:staging` | Full staging deploy (dev.aquilla.app) |
| `pnpm run deploy:codex` | Codex brand to Cloudflare Pages |
| `pnpm run deploy:honeycomb` | Honeycomb brand |
| `pnpm run deploy:context` | Context brand |

## Multi-brand build system

Aquilla ships four brand skins from one codebase. Set `BRAND` at build time:

```bash
BRAND=aquilla    pnpm build     # default; falls back to aquilla on unknown value
BRAND=codex      pnpm build:codex
BRAND=honeycomb  pnpm build:honeycomb
BRAND=context    pnpm build:context
```

Each build script runs `scripts/check-brand-build.ts` after `vite build` to assert
that the correct title, favicon, and theme token appear in `dist/index.html`. A wrong
`BRAND` value silently falls back to `aquilla` (with a console warning), so verify the
output with the check script if brand-switching is load-bearing.

Valid brand IDs are defined in `src/branding/brands/data.ts`.
