# AQU-AGENT TRACES — open TODOs

Format: `- [STATUS] (id) description — how to pick up`

## Wave-2 UI verifier (W2-QA) — 2026-07-21

See `docs/swarm/AQU-AGENT-QA.md` for full verdicts + evidence (`docs/swarm/aqu-agent-qa/*.png`).
Golden path (items 1–5, no-LLM) PASS after 3 small fixes; sandbox (item 6) BLOCKED (no image).

- [FIXED] (qa-cors-artifact-name) Composer paperclip artifact upload failed in-browser on CORS
  preflight — `x-artifact-name` missing from `Access-Control-Allow-Headers`. Added
  `X-Artifact-Name` to `CORS_HEADERS` in auth-worker/src/index.ts. curl never caught it (no
  preflight). Re-verified 201 + pill.
- [FIXED] (qa-brief-envelope) Memory → Project brief tab crashed (React error boundary):
  `getProjectBrief`/`putProjectBrief`/`proposeBriefUpdate`/`reviewBriefProposal` in
  src/lib/agent/memory-api.ts cast the `{brief}`/`{proposal}`/`{proposal,brief}` route envelopes
  as the bare type, so `brief.content` was undefined → `.trim()` TypeError. Unwrapped all 4.
  The unit tests mocked the same wrong shape (false green) — corrected all 4 mocks to the real
  enveloped responses (memory-api.test.ts, 25/25). W1E/W1C seam: confirm any OTHER consumer of
  these routes unwraps correctly.
- [FIXED] (qa-devstack-committing) Pre-existing local PG container 500'd every external `commit`
  (`changesets_status_check` missing `'committing'`); reconciler only adds columns, not CHECK
  constraints. Added an idempotent constraint rebuild in scripts/dev-stack.ts (mirrors the
  AQU-538 PK special-cases). Prod unaffected (migrations carry `committing`).
- [OPEN] (qa-memory-edit-revalidate) AgentMemoryTab approved-memory edit modal does not refetch
  after Save — the row shows stale version/no Human-edited badge until a full reload (sub-tab
  switch doesn't refetch either). Backend correct. Add a `revalidate()`/refetch on save in
  src/components/agent/memory/AgentMemoryTab.tsx. Minor UX, not a blocker.
- [OPEN] (qa-commit-approval-atomicity) In sync-worker external `commit`, the human
  `changeset_confirmations` consume is not in the same transaction as the changeset status
  write: when the status write failed (during qa-devstack-committing), the confirmation was
  already consumed while status stayed `staged`, forcing a re-approval (428). Healthy DBs commit
  fine, but consider wrapping consume+status in one tx — sync-worker/src/external/commit.ts.
- [OPEN] (qa-toolcall-mock-gap) A live agent run streams the timeline + budget meter, but the
  agent-specific frames (`tool.code.*`, `changeset.staged`, `memory.proposed`,
  `budget.exhausted`) are never emitted in a scripted run: mock-openrouter.ts only scripts the
  legacy read/draft/emit/sql/aquifer tools, and the sandbox is down for code frames. To close:
  extend scriptMockResponse() to return a `namedToolCall("propose_memory"|"plan_import", …)` on a
  keyword so the harness executes a new tool and emits its frame; verify run-state.ts pairs
  `tool.code.start`/`tool.code.output` (the w1d-code-pairing scan-from-end path). Frame data
  sources are already verified via API+UI (QA items 2/3/4).

## Wave-2 integrator (W2-INT) — 2026-07-21

- [DONE] (w2int-selector-contract) Added `data-frame-type="<contract frame>"` on run-timeline
  rows (CodeActivityBlock start/output, ChangesetCard, MemoryProposalNotice+BriefProposalNotice,
  BudgetMeter budget/budget.exhausted) and `data-memory-path="<path>"` on memory rows
  (Proposed/ApprovedMemoryList + MemoryProposalNotice). Component tests extended to lock them.
  Closes w1f-selector-contract.
- [DONE] (w2int-page-object) Moved `e2e/pages/agent-page.ts` → `e2e/helpers/page-objects/AgentPage.ts`
  (repo convention); spec import fixed. Closes w1f-page-object-location.
- [DONE] (w2int-attach-affordance) Real composer attach-file: paperclip button + hidden file
  input in the agent composer (AgentDockView) → `uploadAgentArtifact` → new auth-worker route
  `POST /api/v2/projects/:projectId/agent-artifacts` → `{artifactId, fileName}` rides the run
  request (AgentRunRequest.artifacts) → server injects an "attached artifacts" system message
  pointing the model at load_artifact. AgentPage.attachFixture waits on `[data-attachment-id]`.
  Closes w1f-attach-affordance.
- [DONE] (w2int-memory-schema-helper) Deleted `auth-worker/src/__tests__/helpers/agent-memory-schema.ts`
  + its 3 usages — schema.sql now carries the 0066 DDL and the PGlite loader applies schema.sql.
  Closes the agent-memory-schema half of w1b-memory-stub (memory-context-stub.ts already gone at W1B merge).
- [DONE] (w2int-workbench-memory-tab) AgentWorkbench Memory-tab test now mounts W1E's real
  AgentMemoryTab (mocked session + memory-api) instead of the deleted W1D placeholder stub.
  Closes w1d-memory-tab-stub.

- [OPEN] (w2int-live-smoke) Live sandbox exec round-trip NOT verified: Docker daemon is up
  (colima) but `docker pull docker.io/cloudflare/sandbox:0.7.0` hangs — the registry/base-image
  egress is blocked/too slow in this env, so `wrangler dev` on agent-worker fails at "load metadata
  for cloudflare/sandbox:0.7.0" (DeadlineExceeded). VERIFIER: on a box with registry access, run
  `cd agent-worker && npx wrangler dev --port 8790 --var AGENT_SANDBOX_KEY:dev-sandbox-key WRANGLER_LOCAL:1`,
  then `curl -H 'Authorization: Bearer dev-sandbox-key' -X POST 127.0.0.1:8790/sessions/s1/exec
  -d '{"language":"python","code":"print(1+1)"}'` and confirm `/health`. Ties into W1A/dockerfile-pip.
- [OPEN] (w2int-artifact-contract) Artifact-upload route contract for the QA verifier:
  `POST /api/v2/projects/:projectId/agent-artifacts` (auth-worker, session JWT, CONTRIBUTOR+).
  Request: raw file bytes as the body; headers `x-artifact-name` (percent-encoded file name,
  required) + `content-type`. ≤25MB (413/400 over). Response 201
  `{artifactId, fileName, sizeBytes, sha256}`. Errors `{error:{code,message}}` with codes
  permission_denied(403)/validation_failed(400)/storage_unavailable(503)/job_failed(500).
  Side effects: bytes → SNAPSHOTS R2 at `artifacts/{projectId}/{artifactId}` (empty R2_KEY_PREFIX)
  + `artifacts` row (kind='source', credential_id sentinel `'session'`). This is EXACTLY where the
  harness `load_artifact` tool reads (artifacts.r2_key → sandbox fetch-artifact), so an attached
  file is loadable with no other wiring. Local dev: all workers run wrangler's default profile with
  a shared `--persist-to .wrangler-dev-state`, all binding SNAPSHOTS→`aquilla-snapshots`, so the
  auth-worker write and the agent-worker sandbox read hit the same local bucket.
- [NOTE] (w2int-preexisting-failures) Root `vitest run`: 4654 passed, 3 pre-existing failures NOT
  from this work — `ExportDialog.format-reset.test.tsx` (1) + `ImportDialog.import-failed.test.tsx`
  (2). Reproduced on clean base dev@05530248e (and on the integration tip 12f88a0c4); unrelated to
  agent work. auth-worker 750/750, agent-worker 26/26, all typechecks (root tsc -b, tsc.e2e,
  auth-worker, agent-worker) clean.

- [OPEN] (contracts) Orchestrator: write agent-worker contracts + SPA mirror post-recon, commit before Wave 1.
- [OPEN] (tier1-isolates) Ladder Tier 1 as true dynamic-worker isolates (Code Mode) — v1 runs agent JS inside the sandbox container instead.
- [OPEN] (integrations) Monday.com hosted MCP + per-org integration registry — v2.
- [OPEN] (progress-fanout) Queue-based external progress webhooks — v1 is DO→WS only.
- [OPEN] (deploy) agent-worker zone route claim + first `wrangler deploy` — RYDER task (CI token can't mutate routes). Also: create R2 bucket / container image push on first deploy.
- [OPEN] (colima) Local container dev needs `colima start` before `pnpm dev` sandbox testing.
- [OPEN] (stale-docs) CLAUDE.md says workers run on D1 — stale since Postgres cutover; propose doc fix in a later batch (Rule 3: not tonight's scope).
- [OPEN] (w1e-memory-ui) W1E built src/lib/agent/memory-api.ts + src/components/agent/memory/** (AgentMemoryTab, ProposedMemoryList, ApprovedMemoryList, BriefPanel) against §3 exactly as written, incl. a GET for brief proposals that §3's route list doesn't explicitly enumerate (only POST /brief/proposals and POST /brief/proposals/:id/review are listed) — added `listBriefProposals` GET /brief/proposals?status= assuming W1C wires it (the panel needs SOME way to list pending proposals to review); the fetch is wrapped in `.catch(() => [])` so a 404 degrades to an empty list instead of failing the whole tab. W1C: please confirm/land that route or tell W1E the actual shape so this can be corrected.
- [OPEN] (w1e-role-gate) AgentMemoryTab's role gating is client-side UX only (mirrors role-floors.ts's fail-open posture: unknown roleLevel never blocks). Server is authoritative per §3's agent-channel enforcement rules; no toast infra exists in this codebase today so server 403s surface as inline `role="alert"` banners (same pattern as ApiTokensSection), not toasts.
- [OPEN] (w1d-code-pairing) `tool.code.start`/`tool.code.output` (§4) carry no step counter, unlike `code_start`/`code_result`. run-state.ts pairs output with the most recently opened, still-unpaired `CodeActivityItem` (scan-from-end, same posture as the existing code_result fallback). Fine for the current single-call-at-a-time run_code usage; if the harness ever starts concurrent run_code calls within one turn, this needs a real id/step field added to the frames (W1B + this file, additive).
- [OPEN] (w1d-memory-tab-stub) `src/components/agent/memory/AgentMemoryTab.tsx` is a W1D-authored SWARM-TODO placeholder (default export, `{projectId}` prop) so AgentWorkbench's lazy Memory-tab import compiles standalone. W1E's real file replaces it at merge — confirm the export shape (default export, `projectId` prop) matches what W1D wired in AgentWorkbench.tsx, or update the import there.
- [OPEN] (w1f-xlsx-sandbox) `e2e/fixtures/agent/legacy-export.xlsx` was generated + validated (unzip -t, Python openpyxl round-trip) standalone — NOT yet exercised through the actual agent-worker sandbox's `load_artifact` + Tier-2 Python (`pandas.read_excel`) path, since agent-worker doesn't exist yet. Once it does, add an assertion (in `e2e/specs/agent-import.spec.ts` or a lower-level agent-worker test) that the sandbox reads back all 9 rows including the merged-cell title (A1:F1) and the blank interior row (row 5). See `e2e/fixtures/agent/README.md`.
- [OPEN] (w1f-page-object-location) `e2e/pages/agent-page.ts` deviates from this repo's page-object convention (`e2e/helpers/page-objects/*.ts`) per the explicit W1F task assignment path. Wave 2 integrator should decide: keep `e2e/pages/` as a new convention for full-screen-route page objects, or move it into `e2e/helpers/page-objects/AgentPage.ts` for consistency with every other spec. See the file's header comment (Rule 11 flag, not a silent fork).
- [OPEN] (w1f-selector-contract) `e2e/pages/agent-page.ts` selectors assume components emit `data-frame-type="<contract frame name>"` (e.g. `data-frame-type="changeset.staged"`) and memory rows emit `data-memory-path="<path>"`, mirroring this repo's existing `data-cell-id`/`data-testid="lane-switcher"` convention (see `Workspace.ts`). Neither attribute exists yet — W1D/W1E should either confirm they already add it to the new frame renderers or add it so this skeleton's selectors resolve without edits when Wave 2 un-skips the spec (`AGENT_SANDBOX_E2E=1`).
- [OPEN] (w1f-attach-affordance) `AgentPage.attachFixture()` guesses at a composer file-attach UI (`input[type=file]` behind an "Attach file" button) that doesn't exist yet. Contracts §2's `load_artifact` tool resolves an artifact already uploaded to the project (R2-backed via the existing Agent API artifact flow), so the real UI is more likely "upload as project artifact, then reference it in the prompt" than a literal drag-drop on the chat composer — Wave 2 should confirm the actual affordance against W1D's composer work and adjust this method.
- [W1C] (secret-regex-case) `password\s*[:=]` secret pattern implemented case-INSENSITIVE (strengthening over the literal lowercase contract regex) so "Password:" is also caught — db/shared/agent-memory.ts SECRET_PATTERNS. Flag if the contract intended strict lowercase.
- [W1C] (agent-patch-semantics) Contract §3 only names the human_edited→403 guard for agent-channel PATCH. A non-human-edited agent PATCH is otherwise permitted and would set human_edited=true (odd semantics for an agent). Implemented literally per contract; the agent tools (W1B) SHOULD never PATCH — they propose. Revisit if W1B needs an agent-safe edit path.
- [W1C] (brief-approve-applies) Contract §3 underspecifies whether approving a project_brief_proposal writes project_briefs. W1C chose apply-on-approve: reviewBriefProposal adopts the proposal content into the brief (version+1) on approve. If a two-step (approve-then-manually-PUT) flow is wanted instead, drop the putBrief call in db/shared/agent-memory.ts reviewBriefProposal.
- [W1C] (brief-proposals-list) Added GET /:projectId/brief/proposals?status= (VIEWER+, `{proposals}`) per orchestrator addendum — W1E SPA lists brief proposals through it. Not in the original contracts §3 route list.
- [W1C] (brief-proposal-role) POST /brief/proposals gated at CONTRIBUTOR+ for symmetry with memory propose; contract said only "agent or human". Loosen to VIEWER+ if humans below contributor should be able to suggest brief edits.
- [OPEN] (W1A/dockerfile-pip) agent-worker/Dockerfile could not be built/verified (no Docker in build env). Confirm `pip install` resolves in `docker.io/cloudflare/sandbox:0.7.0`; switch to `pip3` / `--break-system-packages` if the base python is externally-managed. Verify at first `wrangler deploy`.
- [OPEN] (W1A/sdk-version) @cloudflare/sandbox pinned to `0.7.0` to match the contract's Docker image `cloudflare/sandbox:0.7.0`. Latest published is 0.12.x — bump SDK + image together if a newer container protocol is wanted (keep major.minor aligned).
- [OPEN] (W1A/exec-stdout-join) exec shaping joins interpreter `logs.stdout[]`/`stderr[]` with `""` (assumes each OutputMessage already carries its own newline). If real container output looks concatenated across print() calls, switch to `"\n"` join in agent-worker/src/exec.ts. Unverifiable without a live container.
- [OPEN] (W1A/wrangler-shape) agent-worker/wrangler.toml uses `[[containers]]` (class_name Sandbox, image ./Dockerfile, instance_type standard-1, max_instances) + `[[durable_objects.bindings]]` Sandbox + `[[migrations]] new_sqlite_classes=["Sandbox"]`, re-declared per env (development/staging/production). Verified against SDK types only; confirm field names against wrangler 4 + Sandbox 0.7 on first `wrangler dev`/deploy. No `routes` anywhere (harness reaches it server-side via AGENT_SANDBOX_URL).
- [OPEN] (W1A/root-vitest-exclude) Added `agent-worker/**` to root vite.config.ts test `exclude` (mirrors auth-worker/sync-worker/worker) so root `pnpm test` doesn't try to run the worker's tests with root-level deps. Single-line infra change outside W1A's exclusive dirs but not in its forbidden set — integrator please confirm.
- [OPEN] (W1A/local-container-boot) dev-stack.ts boots agent-worker on :8790 ONLY when Docker is available (`--no-sandbox` to force-skip); container image build on first `wrangler dev` may exceed the 120s readiness probe — boot is best-effort (warn + continue, not fatal). Needs `colima start` locally. AGENT_SANDBOX_URL/KEY passed to auth-worker only when the sandbox actually came up.
- [OPEN] (w1b-memory-stub) auth-worker/src/lib/agent/memory-context-stub.ts + src/__tests__/helpers/agent-memory-schema.ts are local stubs against W1C's contract §3 signature — on merge, delete both and import buildMemoryContext from db/shared/agent-memory; the tables come from W1C's 0066_agent_memory.sql migration into db/postgres/schema.sql.
- [OPEN] (w1b-plan-import-translated) plan_import maps cells original→content, group→section, type→type; `translated`/`context` are dropped (PlanImport seeds SOURCE cells only). A create-then-translate flow (follow-up SetTranslation changeset carrying `translated`) is a Wave-3 item — see changeset-bridge.ts toCommandCells SWARM-TODO.
- [OPEN] (w1b-load-artifact-key) load_artifact reads artifacts.r2_key directly from the shared DB (project-scoped) rather than the sync-worker external metadata GET (which omits r2_key by design). If artifact storage moves behind a signed-URL service, switch to a sync-worker GET that returns a fetch key — see harness-tools.ts loadArtifact SWARM-TODO.
- [OPEN] (w1b-sandbox-url) auth-worker wrangler.toml sets AGENT_SANDBOX_URL only for dev/e2e (127.0.0.1:8790); top-level/prod/staging leave it commented until aquilla-agent-sandbox has a stable URL. Set it + the AGENT_SANDBOX_KEY secret before agent code-exec works in those envs (harness degrades to a clear "sandbox unavailable" tool error meanwhile).

## Wave-3 FIX-B (SPA fixer) — 2026-07-21

Applied all 5 adversarial-panel SPA fixes. Coded against FIX-A's stated NEW backend contracts
(memory review 409 `supersedes_human_edited` w/ `details:{path,existingId}`; brief proposal
approve 409 `conflict` w/ `details:{baseVersion,currentVersion}`) — not yet verified against a
live FIX-A route since it lands in parallel; if the actual envelope differs, only
`memory-api.ts`'s `parseErrorAndThrow` needs updating (both new error classes are the only
readers of `error.details`).

- [FIXED] (races-F5) `AgentMemoryTab.tsx` reviewMemory/reviewProposal now revert by id
  (`cur.map(m => m.id===original.id ? original : m)`) instead of restoring an absolute
  pre-action snapshot — a concurrent review's optimistic flip on another row survives a sibling
  row's failure. Proof test: `AgentMemoryTab.test.tsx` "races-F5: a failed review only reverts
  its own row, not a concurrent successful one".
- [FIXED] (B1/supersede) `memory-api.ts` adds `SupersedesHumanEditedError` (path/existingId) and
  `reviewAgentMemory` takes an optional `supersedeHumanEdited` flag, sent ONLY on explicit
  re-confirm (never auto-retried). `AgentMemoryTab.tsx` shows a destructive confirm dialog
  ("Approving will replace the human-edited memory at <path>...") on that 409; confirm resends
  with the flag, cancel leaves the (already-reverted) row untouched. Proof tests: "supersede-
  human-edited confirm (B1)" × 3 (dialog shows + reverts meanwhile / confirm resends with flag /
  cancel never resends).
- [FIXED] (mem-M2/M3) New `src/lib/agent/text-diff.ts` — hand-rolled LCS line diff, no new deps
  (`diffLines`/`hasChanges`, 5 unit tests). `BriefPanel.tsx` renders each pending proposal as a
  diff of `brief.content` vs `proposal.content` (green `+`/red `-` lines) instead of a bare
  markdown re-render. `VersionConflictError` extended with `baseVersion`; a 409 `conflict` on
  approve marks that proposal card "Stale — brief changed since this was proposed (vN → vM)"
  with Approve disabled (Reject still works) via a `staleProposals: Map<id, info>` state in
  `AgentMemoryTab.tsx`, cleared optimistically on retry. Proof tests: "brief proposal diff +
  stale state (mem-M2/M3)" × 2.
- [FIXED] (mem-M5, changeset half) `ChangesetCard.tsx` now polls
  `GET /api/v2/changesets/:id/approval` (same shape as `pages/ApproveChangeset/ApproveChangeset.tsx`)
  every 5s via `useFrontierSession` + `AUTH_BASE`, while mounted and non-terminal; flips a status
  badge and disables the "Review & approve" link (renders as plain text) once
  approved/committed/discarded, and stops polling. Proof tests: "polls the approval route and
  flips the badge…" / "stops polling once a terminal status is reached" (fake timers).
- [FIXED] (mem-M5, memory-notice half) — DEVIATION FROM THE BRIEF: rather than a
  `window.dispatchEvent`/`aquilla:agent-memory-reviewed` custom event, used the EXISTING
  per-project `AgentSessionStore` singleton (`src/lib/agent/session-store.ts`) as the clean
  channel: `AgentMemoryTab` already knows `projectId`, so on a successful review it calls
  `agentSessionStore(projectId).markMemoryReviewed(id)` / `.markBriefReviewed(id)` directly — new
  pure reducers `markMemoryReviewed`/`markBriefReviewed` in `run-state.ts`, new store methods in
  `session-store.ts` that scan all runs. `MemoryProposedItem`/`BriefProposedItem` gained an
  optional `status?: "pending"|"reviewed"` field (frames default it to `"pending"`).
  `MemoryProposalNotice`/`BriefProposalNotice` render a "Reviewed" badge instead of the "Review in
  Memory tab" link once flipped — any mounted `AgentRunView` on the same project re-renders via
  the shared store, no window event needed. Flag for orchestrator: if a cross-tab (multi-window)
  notice sync is ever wanted, THAT would need the window-event fallback the task described —
  the store is same-tab-only. Proof tests: `run-state.test.ts` (2), `session-store.test.ts`
  ("markMemoryReviewed/markBriefReviewed flip the matching notice across all runs"),
  `MemoryProposalNotice.test.tsx` (2), `AgentMemoryTab.test.tsx` ("calls markMemoryReviewed on
  the shared session store after a successful review").
- [FIXED] (mem-m2) `AgentMemoryTab.tsx` subscribes to `useAgentSession(projectId)` and counts
  `memory-proposed` timeline items across all runs; when the count grows while mounted, it
  refetches `listAgentMemories` (best-effort, swallows errors — the next full `load()` retries).
  Proof test: "refetches the memory list when a new memory-proposed run item lands (mem-m2)".

Verification: root `npx tsc -b --noEmit` clean. `npx vitest run src/components/agent
src/lib/agent` — 23 files, 179 tests, all green (was 164 before this batch; +15 new tests, no
regressions). `npx eslint` clean on all touched/new files. No new dependencies. All touched
files well under 500 lines (largest: `AgentMemoryTab.tsx` 388, `run-state.ts` 342).

- [OPEN] (fixb-contract-unverified) The 409 envelope shapes for `supersedes_human_edited` and
  brief-proposal `conflict` are coded from the orchestrator's stated contract, not a live FIX-A
  route (parallel work) — re-verify `memory-api.ts`'s `parseErrorAndThrow` against FIX-A's actual
  auth-worker response once merged; only that function and the two new error classes would need
  adjusting if the shape drifts.
- [OPEN] (fixb-changeset-status-values) `ChangesetCard.tsx`'s terminal-status set
  (`approved`/`committed`/`discarded`) is inferred from `ApproveChangeset.tsx`'s UI copy — the
  `/approval` route's `status` field is untyped (`string`) server-side. If the backend adds/
  renames a terminal status, update `TERMINAL_STATUSES` in `ChangesetCard.tsx`.
