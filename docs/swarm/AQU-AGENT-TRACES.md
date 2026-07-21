# AQU-AGENT TRACES — open TODOs

Format: `- [STATUS] (id) description — how to pick up`

- [OPEN] (contracts) Orchestrator: write agent-worker contracts + SPA mirror post-recon, commit before Wave 1.
- [OPEN] (tier1-isolates) Ladder Tier 1 as true dynamic-worker isolates (Code Mode) — v1 runs agent JS inside the sandbox container instead.
- [OPEN] (integrations) Monday.com hosted MCP + per-org integration registry — v2.
- [OPEN] (progress-fanout) Queue-based external progress webhooks — v1 is DO→WS only.
- [OPEN] (deploy) agent-worker zone route claim + first `wrangler deploy` — RYDER task (CI token can't mutate routes). Also: create R2 bucket / container image push on first deploy.
- [OPEN] (colima) Local container dev needs `colima start` before `pnpm dev` sandbox testing.
- [OPEN] (stale-docs) CLAUDE.md says workers run on D1 — stale since Postgres cutover; propose doc fix in a later batch (Rule 3: not tonight's scope).
- [OPEN] (w1d-code-pairing) `tool.code.start`/`tool.code.output` (§4) carry no step counter, unlike `code_start`/`code_result`. run-state.ts pairs output with the most recently opened, still-unpaired `CodeActivityItem` (scan-from-end, same posture as the existing code_result fallback). Fine for the current single-call-at-a-time run_code usage; if the harness ever starts concurrent run_code calls within one turn, this needs a real id/step field added to the frames (W1B + this file, additive).
- [OPEN] (w1d-memory-tab-stub) `src/components/agent/memory/AgentMemoryTab.tsx` is a W1D-authored SWARM-TODO placeholder (default export, `{projectId}` prop) so AgentWorkbench's lazy Memory-tab import compiles standalone. W1E's real file replaces it at merge — confirm the export shape (default export, `projectId` prop) matches what W1D wired in AgentWorkbench.tsx, or update the import there.
