# AQU-AGENT TRACES — open TODOs

Format: `- [STATUS] (id) description — how to pick up`

- [OPEN] (contracts) Orchestrator: write agent-worker contracts + SPA mirror post-recon, commit before Wave 1.
- [OPEN] (tier1-isolates) Ladder Tier 1 as true dynamic-worker isolates (Code Mode) — v1 runs agent JS inside the sandbox container instead.
- [OPEN] (integrations) Monday.com hosted MCP + per-org integration registry — v2.
- [OPEN] (progress-fanout) Queue-based external progress webhooks — v1 is DO→WS only.
- [OPEN] (deploy) agent-worker zone route claim + first `wrangler deploy` — RYDER task (CI token can't mutate routes). Also: create R2 bucket / container image push on first deploy.
- [OPEN] (colima) Local container dev needs `colima start` before `pnpm dev` sandbox testing.
- [OPEN] (stale-docs) CLAUDE.md says workers run on D1 — stale since Postgres cutover; propose doc fix in a later batch (Rule 3: not tonight's scope).
- [OPEN] (W1A/dockerfile-pip) agent-worker/Dockerfile could not be built/verified (no Docker in build env). Confirm `pip install` resolves in `docker.io/cloudflare/sandbox:0.7.0`; switch to `pip3` / `--break-system-packages` if the base python is externally-managed. Verify at first `wrangler deploy`.
- [OPEN] (W1A/sdk-version) @cloudflare/sandbox pinned to `0.7.0` to match the contract's Docker image `cloudflare/sandbox:0.7.0`. Latest published is 0.12.x — bump SDK + image together if a newer container protocol is wanted (keep major.minor aligned).
- [OPEN] (W1A/exec-stdout-join) exec shaping joins interpreter `logs.stdout[]`/`stderr[]` with `""` (assumes each OutputMessage already carries its own newline). If real container output looks concatenated across print() calls, switch to `"\n"` join in agent-worker/src/exec.ts. Unverifiable without a live container.
- [OPEN] (W1A/wrangler-shape) agent-worker/wrangler.toml uses `[[containers]]` (class_name Sandbox, image ./Dockerfile, instance_type standard-1, max_instances) + `[[durable_objects.bindings]]` Sandbox + `[[migrations]] new_sqlite_classes=["Sandbox"]`, re-declared per env (development/staging/production). Verified against SDK types only; confirm field names against wrangler 4 + Sandbox 0.7 on first `wrangler dev`/deploy. No `routes` anywhere (harness reaches it server-side via AGENT_SANDBOX_URL).
- [OPEN] (W1A/root-vitest-exclude) Added `agent-worker/**` to root vite.config.ts test `exclude` (mirrors auth-worker/sync-worker/worker) so root `pnpm test` doesn't try to run the worker's tests with root-level deps. Single-line infra change outside W1A's exclusive dirs but not in its forbidden set — integrator please confirm.
- [OPEN] (W1A/local-container-boot) dev-stack.ts boots agent-worker on :8790 ONLY when Docker is available (`--no-sandbox` to force-skip); container image build on first `wrangler dev` may exceed the 120s readiness probe — boot is best-effort (warn + continue, not fatal). Needs `colima start` locally. AGENT_SANDBOX_URL/KEY passed to auth-worker only when the sandbox actually came up.
