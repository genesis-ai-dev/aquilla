# AQU-AGENT TRACES — open TODOs

Format: `- [STATUS] (id) description — how to pick up`

- [OPEN] (contracts) Orchestrator: write agent-worker contracts + SPA mirror post-recon, commit before Wave 1.
- [OPEN] (tier1-isolates) Ladder Tier 1 as true dynamic-worker isolates (Code Mode) — v1 runs agent JS inside the sandbox container instead.
- [OPEN] (integrations) Monday.com hosted MCP + per-org integration registry — v2.
- [OPEN] (progress-fanout) Queue-based external progress webhooks — v1 is DO→WS only.
- [OPEN] (deploy) agent-worker zone route claim + first `wrangler deploy` — RYDER task (CI token can't mutate routes). Also: create R2 bucket / container image push on first deploy.
- [OPEN] (colima) Local container dev needs `colima start` before `pnpm dev` sandbox testing.
- [OPEN] (stale-docs) CLAUDE.md says workers run on D1 — stale since Postgres cutover; propose doc fix in a later batch (Rule 3: not tonight's scope).
- [OPEN] (w1e-memory-ui) W1E built src/lib/agent/memory-api.ts + src/components/agent/memory/** (AgentMemoryTab, ProposedMemoryList, ApprovedMemoryList, BriefPanel) against §3 exactly as written, incl. a GET for brief proposals that §3's route list doesn't explicitly enumerate (only POST /brief/proposals and POST /brief/proposals/:id/review are listed) — added `listBriefProposals` GET /brief/proposals?status= assuming W1C wires it (the panel needs SOME way to list pending proposals to review); the fetch is wrapped in `.catch(() => [])` so a 404 degrades to an empty list instead of failing the whole tab. W1C: please confirm/land that route or tell W1E the actual shape so this can be corrected.
- [OPEN] (w1e-role-gate) AgentMemoryTab's role gating is client-side UX only (mirrors role-floors.ts's fail-open posture: unknown roleLevel never blocks). Server is authoritative per §3's agent-channel enforcement rules; no toast infra exists in this codebase today so server 403s surface as inline `role="alert"` banners (same pattern as ApiTokensSection), not toasts.
