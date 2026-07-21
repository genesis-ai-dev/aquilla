# AQU-AGENT TRACES — open TODOs

Format: `- [STATUS] (id) description — how to pick up`

- [OPEN] (contracts) Orchestrator: write agent-worker contracts + SPA mirror post-recon, commit before Wave 1.
- [OPEN] (tier1-isolates) Ladder Tier 1 as true dynamic-worker isolates (Code Mode) — v1 runs agent JS inside the sandbox container instead.
- [OPEN] (integrations) Monday.com hosted MCP + per-org integration registry — v2.
- [OPEN] (progress-fanout) Queue-based external progress webhooks — v1 is DO→WS only.
- [OPEN] (deploy) agent-worker zone route claim + first `wrangler deploy` — RYDER task (CI token can't mutate routes). Also: create R2 bucket / container image push on first deploy.
- [OPEN] (colima) Local container dev needs `colima start` before `pnpm dev` sandbox testing.
- [OPEN] (stale-docs) CLAUDE.md says workers run on D1 — stale since Postgres cutover; propose doc fix in a later batch (Rule 3: not tonight's scope).
