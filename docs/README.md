# Aquilla documentation

Use this index to distinguish current operational documentation from historical
design and audit material.

## Current operational truth

- [Self hosting guide](SELF-HOSTING.md) — local evaluation, your own Cloudflare
  deployment, required and optional services, database bootstrap, and operations.
- [Deployment environments](DEPLOYMENT-ENVIRONMENTS.md) — canonical branch,
  Wrangler profile, hostname, Worker, Neon branch, R2 bucket, and deploy-command
  mapping.
- [System specification](SPEC.md) — current product and system boundaries.
- [Sync architecture](SYNC.md) — current event, projection, realtime, and blob
  ownership.
- [Cloudflare Workers Builds](runbooks/cloudflare-workers-builds.md) — disconnected
  build integrations, explicit deployment ownership, previews, and verification.
- [Hetzner self-hosted e2e](runbooks/hetzner-ci.md) — dedicated-box Playwright
  smoke; GitHub remains the webhook and queue.
- [Seed a project into a local database](runbooks/seed-project-to-local.md) — hand
  a developer a PII-scrubbed copy of one project without Neon or R2 access
  (`seed:extract:dev` → bundle → `seed:load --local`).
- [E2E](../e2e/README.md) — local integration and smoke-test environment.
- Postgres row-level security — the policies themselves are the documentation:
  `db/postgres/migrations/` (for example `0136_contextual_run_traces_rls.sql`).
  There is no separate rollout document today; this index used to link an
  `RLS-ROLLOUT.md` that is no longer in the tree.
- [Operational security](OPSEC.md) — sensitive data inventory, threat model,
  open risks, and which security controls are actually enforced. Re-run its
  mechanical checks with `pnpm run scan:secrets` and `pnpm audit --prod`.
- [Inworld TTS 2 Flash](INWORLD-TTS.md) — commercial hosted TTS / clone
  engine (AQU-1189). Where to put `INWORLD_API_KEY`.
- [Monday.com integration](MONDAY-INTEGRATION.md) — the connection, board link
  and mapping contract, and the webhook address each environment needs.
- [Architecture decisions](decisions/INDEX.md) — one page per decision that
  shapes behaviour you cannot read off a single file. Claims are pinned to a
  file and an exported symbol; `pnpm run check:doc-pins` fails when a pin stops
  resolving.
- [Batch endpoint contract](BATCH_ENDPOINT_CONTRACT.md) — the **frozen** Batch
  Translation API v1. `src/lib/batch/*` and `parity/batch/contract.test.ts` are
  written against it; shapes do not change without a `/batch/v2`.
- [Tauri desktop shell release checklist](TAURI-RELEASE-CHECKLIST.md) — what the
  `v*` tag workflow already does, and the signing/updater placeholders still
  outstanding before a signed desktop build can ship.

Runtime configuration in `wrangler.toml`, `auth-worker/wrangler.toml`,
`sync-worker/wrangler.toml`, the deploy workflows, and `package.json` is enforced
against the deployment matrix by `scripts/worker-deployment-contract.test.ts`.
Change the configuration, matrix, and test together.

## Product behavior specification

The sibling `aquilla-specs` repository is the source of truth for intended product
behavior. Its implementation documents describe the deployed topology and
environment contract. This repository remains the source of truth for exact live
resource identifiers and executable deploy commands.

## Historical and reference material

These preserve decisions and provenance. **They are not live deployment
instructions** unless a current document above links to them for a specific
procedure. In particular, references to D1 as the live event store,
`frontier-server`, or a VS Code extension describe retired architectures.

Folders that are history:

| Folder | What it holds |
| --- | --- |
| [`archive/`](archive/README.md) | Closed, dated exercises — today the Matecat parity run of 2026-07-04. Several files there are frozen or append-only; do not edit them. |
| `benchmarks/`, `forecast/` | Measurements taken on a given day against a given build. |
| `brainstorms/`, `design/`, `plans/`, `specs/`, `superpowers/` | Proposals and design explorations, some shipped, some not. |
| `swarm/`, `v3-audit/` | Multi-agent run traces and a point-in-time codebase audit. |

Dated files at the top of `docs/` are history too, whatever their subject:
`OPSEC-REVIEW-<date>.md`, `AUDIT-<date>.md`, `SECURITY-NOTES-<date>.md`,
`UX-JOURNEY-AUDIT-<date>.md`, `JEV-SHADOW-EVAL-<date>.md`, and per-ticket notes
such as `AQU-1309-reproduction.md`. `OPSEC.md` (undated) is the live one.

Everything else under `docs/` is current reference: `api/` and `agent-api/`
(external API surface), `decisions/` (pinned architecture decisions),
`distribution/`, `pricing/`, `routines/` (scheduled agent routines),
`runbooks/` (operational procedures, some dated by the incident they document)
and `walkthroughs/`.

The repository root deliberately holds only entry points — `README.md`,
`AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `LICENSE`, `TRADEMARKS.md` — plus
`PARITY_MATRIX.yaml`, which stays at the root because
`parity/instruments/parity-score.ts` reads it from there. Reports and logs
belong in `docs/archive/`, not beside `README.md` where they read as current
truth.
