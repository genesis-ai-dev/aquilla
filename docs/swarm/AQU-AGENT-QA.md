# AQU-AGENT — Wave-2 UI verification (W2-QA)

Date: 2026-07-21 · Verifier: Claude (W2-QA) · Branch: `swarm/integration` @ worktree
`.worktrees/swarm-integration`. Stack booted locally via `pnpm dev` (identity :8788,
sync :8789, mock-openrouter :9456, vite :5173). **agent-worker :8790 skipped — no
`cloudflare/sandbox` Docker image in this env** (confirmed `docker image ls` empty), so
the stack degrades gracefully (`agent -> skipped … "sandbox unavailable"`).

Seed: `POST /__dev__/login` (user `dev`, org `Dev Org`, project `dev-project`).
Evidence PNGs in `docs/swarm/aqu-agent-qa/`; reproducible via
`pnpm tsx scripts/qa/agent-evidence.mts` (drives the whole non-LLM golden path).

## Verdicts

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Agent workbench loads (`/project/:id/agent`: Sessions+Memory tabs, composer, paperclip) | **PASS** | `01-agent-workbench.png` |
| 2 | Memory flow live e2e (propose via agent header → Proposed queue → Approve → Edit → human-edited badge → 403 enforcement) | **PASS** (1 minor UX bug) | `02`/`03`/`04-memory-*.png` |
| 2b | Brief: agent proposal via API → review in UI | **PASS after fix** | `05-brief-proposal.png` |
| 3 | Artifact upload via composer paperclip → pill → 201 + artifacts row + R2 | **PASS after fix** | `06-artifact-pill.png` |
| 4 | Changeset approval flow live (mint aqk_ → stage PlanImport → `/approve/:id` → approve → commit → cells land) | **PASS** | `08`/`09-approve-*.png` |
| 5 | Agent run streaming (mock LLM) — timeline frames + budget meter | **PASS** (new-frame gap) | `07-run-timeline.png` |
| 6 | Sandbox live exec | **BLOCKED** (no Docker image) — degrade verified | n/a |

**Overall: golden path is READY** for the non-LLM write/review paths (the agent's actual
value surface), after 3 small fixes committed on `swarm/integration` (below). The only
unverified live surfaces are sandbox code-exec (item 6, environmental) and in-timeline
rendering of the agent-specific SSE frames (`tool.code.*`, `changeset.staged`,
`memory.proposed`) — the mock scripts only the legacy tools, so those frames' data sources
were verified via API+UI instead of via a scripted run (see gap note).

## Bugs found & fixed (committed here)

1. **Artifact attach broken in-browser (CORS).** The composer paperclip upload failed with
   `x-artifact-name is not allowed by Access-Control-Allow-Headers`; the user saw "Could not
   attach that file." `curl` passed because it does no preflight — the route itself is fine.
   Fix: added `X-Artifact-Name` to `CORS_HEADERS` in `auth-worker/src/index.ts`. Re-verified:
   upload 201, pill renders (`06-artifact-pill.png`).
2. **Project brief tab crashes (envelope unwrap).** Clicking Memory → Project brief threw
   `TypeError: Cannot read properties of undefined (reading 'trim')` (React error boundary,
   whole tab dead). Root cause: `/brief` returns `{brief}` and the proposal routes return
   `{proposal}`/`{proposal,brief}`, but `src/lib/agent/memory-api.ts` cast the raw envelope as
   the bare type — so `brief.content` was undefined. Fix: unwrap `.brief`/`.proposal` in
   `getProjectBrief`, `putProjectBrief`, `proposeBriefUpdate`, `reviewBriefProposal`.
   **The existing unit tests mocked the same wrong (bare) shape**, so they gave false
   confidence — updated all 4 mocks to the real enveloped responses (25/25 pass).
3. **dev-stack schema drift blocked `commit`.** A pre-existing local Postgres container
   (created before the Agent API's `committing` status) carried an old
   `changesets_status_check` missing `'committing'`, so every external `commit` 500'd
   (`changesets_status_check` violation). The reconciler only adds columns, never CHECK
   constraints. Fix: added a targeted, idempotent constraint rebuild in
   `scripts/dev-stack.ts` (mirrors the existing AQU-538 PK-rebuild special-cases). Prod is
   unaffected (real migrations carry `committing`). Live DB also patched to unblock this run.

## Findings NOT fixed (documented)

- **Memory edit does not auto-revalidate (minor UX).** After Save in the approved-memory edit
  modal, the row keeps showing the stale version and no Human-edited badge until a full page
  reload; switching sub-tabs doesn't refetch. Backend is correct (PATCH → `humanEdited=true`,
  `version+1`, verified via API and after reload — `04-memory-human-edited-badge.png`). This is
  a client refetch gap in `AgentMemoryTab`, not a data bug. Left for W1E/owner (not a blocker).
- **Commit consumes the human approval before the status write (atomicity).** During bug #3,
  the failed commit had already consumed the `changeset_confirmations` row before the constraint
  error, so the retry saw "no unconsumed approval" (428) even though status was still `staged`.
  In a healthy DB commit succeeds atomically, but the consume + status-update not sharing one
  transaction is a latent concern worth a Wave-3 look at `sync-worker/src/external/commit.ts`.

## Detailed repro (per item)

### 1 — Workbench (PASS)
`/project/dev-project/agent` renders header `Agent`, tab slot `Sessions | Memory`, the composer
("Ask the agent…", paperclip "Attach file", Send). Only console errors are pre-existing
BetaBadge `nativeButton` warnings (header "Beta" badge, unrelated to agent code).

### 2 — Memory (PASS + minor UX)
- Agent proposes: `POST /api/v2/projects/dev-project/agent-memory` with `x-aquilla-agent-run`
  → row appears in **Proposed** with a `run <id>` provenance badge (`02`).
- Approve in UI → moves to **Approved**, shows `v1` + Edit (`03`).
- Edit in UI (content textarea → Save) → after reload shows **Human-edited** badge + `v2`,
  content updated (`04`). API confirms `humanEdited=true, version=2`.
- Enforcement (agent channel, `x-aquilla-agent-run`): PATCH a human-edited row → `403
  human_edit_protected`; PATCH a fresh (non-human-edited) approved row → `403
  agent_edit_forbidden`. Both verified via curl.

### 2b — Brief (PASS after fix #2)
Agent brief proposal via `POST /brief/proposals` (agent header) → renders under Memory →
Project brief with the "high-oversight: human approval only" banner + Reject/Approve (`05`).

### 3 — Artifact (PASS after fix #1)
Composer paperclip → hidden `input[type=file]` → `uploadAgentArtifact` →
`POST /api/v2/projects/dev-project/agent-artifacts` (raw bytes, `x-artifact-name`) → **201**
`{artifactId,fileName,sizeBytes,sha256}`; pill `mixed-notes.csv` renders (`06`). Backend
verified: `artifacts` row `kind='source'`, `credential_id='session'`,
`r2_key='artifacts/dev-project/<id>'`, sha256 match; R2 blob present in the shared
`.wrangler-dev-state` `aquilla-snapshots` bucket.

### 4 — Changeset (PASS)
Mint ask-mode `aqk_` project credential (`POST /api/v2/credentials`) → stage PlanImport
(`POST :8789/api/v1/external/projects/dev-project/changesets`) → `/approve/:changesetId`
renders "Files created: 1, Source cells added: 3" + digest/expiry (`08`) → Approve → "it can
now commit" (`09`) → external `commit` → **200**, receipt `appliedCount 4`, and
`mixed-notes.csv` + 3 source cells land in the project DB (and appear in the file sidebar).

### 5 — Run streaming (PASS; new-frame gap)
Sent a plain prompt; the SSE run streamed into the timeline: user bubble → assistant text →
`read :file · all` tool-activity block → tool result → token-usage line → **budget meter
`$0.00 / $5.00`** (the `budget` frame; cap = default 500¢) (`07`). Gap: the mock
(`scripts/mock-openrouter.ts`) only scripts the legacy `read/draft/emit/sql/aquifer` tools, so
the agent-specific frames (`tool.code.*`, `changeset.staged`, `memory.proposed`,
`budget.exhausted`) don't render in a live run here — extending the mock to call a new tool was
out of scope given the sandbox is also down. Their data sources are independently verified
(items 2/3/4).

### 6 — Sandbox (BLOCKED)
`docker image ls | grep cloudflare/sandbox` empty → `wrangler dev` on agent-worker can't load
the base image; dev-stack skips it and the harness reports "sandbox unavailable" (verified: on
reboot the boot attempt timed out and the stack continued cleanly). Ties into TRACES
`w2int-live-smoke` / `W1A/dockerfile-pip` — re-run on a box with registry access.
