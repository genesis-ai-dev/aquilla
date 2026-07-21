# AQU-AGENT TRACES — open TODOs

Format: `- [STATUS] (id) description — how to pick up`

- [OPEN] (contracts) Orchestrator: write agent-worker contracts + SPA mirror post-recon, commit before Wave 1.
- [OPEN] (tier1-isolates) Ladder Tier 1 as true dynamic-worker isolates (Code Mode) — v1 runs agent JS inside the sandbox container instead.
- [OPEN] (integrations) Monday.com hosted MCP + per-org integration registry — v2.
- [OPEN] (progress-fanout) Queue-based external progress webhooks — v1 is DO→WS only.
- [OPEN] (deploy) agent-worker zone route claim + first `wrangler deploy` — RYDER task (CI token can't mutate routes). Also: create R2 bucket / container image push on first deploy.
- [OPEN] (colima) Local container dev needs `colima start` before `pnpm dev` sandbox testing.
- [OPEN] (stale-docs) CLAUDE.md says workers run on D1 — stale since Postgres cutover; propose doc fix in a later batch (Rule 3: not tonight's scope).
- [W1C] (secret-regex-case) `password\s*[:=]` secret pattern implemented case-INSENSITIVE (strengthening over the literal lowercase contract regex) so "Password:" is also caught — db/shared/agent-memory.ts SECRET_PATTERNS. Flag if the contract intended strict lowercase.
- [W1C] (agent-patch-semantics) Contract §3 only names the human_edited→403 guard for agent-channel PATCH. A non-human-edited agent PATCH is otherwise permitted and would set human_edited=true (odd semantics for an agent). Implemented literally per contract; the agent tools (W1B) SHOULD never PATCH — they propose. Revisit if W1B needs an agent-safe edit path.
- [W1C] (brief-approve-applies) Contract §3 underspecifies whether approving a project_brief_proposal writes project_briefs. W1C chose apply-on-approve: reviewBriefProposal adopts the proposal content into the brief (version+1) on approve. If a two-step (approve-then-manually-PUT) flow is wanted instead, drop the putBrief call in db/shared/agent-memory.ts reviewBriefProposal.
- [W1C] (brief-proposals-list) Added GET /:projectId/brief/proposals?status= (VIEWER+, `{proposals}`) per orchestrator addendum — W1E SPA lists brief proposals through it. Not in the original contracts §3 route list.
- [W1C] (brief-proposal-role) POST /brief/proposals gated at CONTRIBUTOR+ for symmetry with memory propose; contract said only "agent or human". Loosen to VIEWER+ if humans below contributor should be able to suggest brief edits.
