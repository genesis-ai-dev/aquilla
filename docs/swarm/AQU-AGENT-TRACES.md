# AQU-AGENT TRACES — open TODOs

Format: `- [STATUS] (id) description — how to pick up`

- [OPEN] (contracts) Orchestrator: write agent-worker contracts + SPA mirror post-recon, commit before Wave 1.
- [OPEN] (tier1-isolates) Ladder Tier 1 as true dynamic-worker isolates (Code Mode) — v1 runs agent JS inside the sandbox container instead.
- [OPEN] (integrations) Monday.com hosted MCP + per-org integration registry — v2.
- [OPEN] (progress-fanout) Queue-based external progress webhooks — v1 is DO→WS only.
- [OPEN] (deploy) agent-worker zone route claim + first `wrangler deploy` — RYDER task (CI token can't mutate routes). Also: create R2 bucket / container image push on first deploy.
- [OPEN] (colima) Local container dev needs `colima start` before `pnpm dev` sandbox testing.
- [OPEN] (stale-docs) CLAUDE.md says workers run on D1 — stale since Postgres cutover; propose doc fix in a later batch (Rule 3: not tonight's scope).
- [OPEN] (w1b-memory-stub) auth-worker/src/lib/agent/memory-context-stub.ts + src/__tests__/helpers/agent-memory-schema.ts are local stubs against W1C's contract §3 signature — on merge, delete both and import buildMemoryContext from db/shared/agent-memory; the tables come from W1C's 0066_agent_memory.sql migration into db/postgres/schema.sql.
- [OPEN] (w1b-plan-import-translated) plan_import maps cells original→content, group→section, type→type; `translated`/`context` are dropped (PlanImport seeds SOURCE cells only). A create-then-translate flow (follow-up SetTranslation changeset carrying `translated`) is a Wave-3 item — see changeset-bridge.ts toCommandCells SWARM-TODO.
- [OPEN] (w1b-load-artifact-key) load_artifact reads artifacts.r2_key directly from the shared DB (project-scoped) rather than the sync-worker external metadata GET (which omits r2_key by design). If artifact storage moves behind a signed-URL service, switch to a sync-worker GET that returns a fetch key — see harness-tools.ts loadArtifact SWARM-TODO.
- [OPEN] (w1b-sandbox-url) auth-worker wrangler.toml sets AGENT_SANDBOX_URL only for dev/e2e (127.0.0.1:8790); top-level/prod/staging leave it commented until aquilla-agent-sandbox has a stable URL. Set it + the AGENT_SANDBOX_KEY secret before agent code-exec works in those envs (harness degrades to a clear "sandbox unavailable" tool error meanwhile).
