# PD7 Swarm — Prototype Debugging, prioritized Urgent/High batch (2026-07-06)

Driver: `/swarm` on Linear project **Prototype Debugging** (id `215cff7b-1a95-443d-9343-1f1528754462`).
Scope per user: **a prioritized batch, NOT a full drain** of the 61 Todos — the 2 Urgent + 11
code-fixable High issues (13 issues, 12 workstreams; AQU-347+364 share the invite surface).
Base: **dev @ `b686b4e74`** (clean apart from protected untracked docs below). Integration:
`swarm/pd7-integration` (worktree `.worktrees/pd7-integration`). **Promotion target: dev**
(repo works dev→main via PR; LINKEDPROJ precedent).
CONCURRENT ACTORS: the Linked Projects swarm (`swarm/linkedproj-integration`, lp-qa-fixes fixer
pending) is live in this repo — re-check dev tip before every promotion; compose, don't pick-one.

## §0 STOP checklist — CONVERGED 2026-07-06, promoted dev@0189d3971
- [x] AQU-346, 365, 347, 364, 408, 414, 361, 366, 334, 416, 360, 348, 325 all at **Fixed** (13/13,
      Linear audited).
- [x] Integration green: tsc 0 · vitest 3532/3532 (429 files) · build+brand OK.
- [x] sync-worker 722/722 + auth-worker 540/540 (composed pd7+linked-projects tree).
- [x] Every fix live-UI verified by the QA singleton (punchlist §PD7 + re-verify sections):
      9 PASS first pass; 334/346/347 fixed+re-verified PASS (347 took 3 rounds: server, client JWT,
      no-store); 361 failure-banner PASS, happy path honestly BLOCKED-env. Spec reconciled
      (aquilla-specs: AQU-416, AQU-347/364, AQU-408 commits by orchestrator).
- [x] Promoted to dev @ 0189d3971 (--no-ff); dev tip re-checked (advanced 14 commits by the LP swarm
      mid-run → merged into integration, 5 conflicts composed additively, full re-gate before promote);
      promoted tree byte-identical to gated tree.
- [x] Gaps traced in `docs/swarm/TRACES.md` §PD7.

## §EXCLUDED (and why)
- AQU-153, AQU-224, AQU-227 — pre-existing `Dispatched` locks (stale, from June sessions). None
  in this batch's priority set; NOT reclaimed this run.
- AQU-426, AQU-434, AQU-410 — manual-QA / human tracking tasks, not agent work.
- AQU-442 — design approval (HITL), AQU-318 — Milestones feature (oversized, needs own project
  decomposition), AQU-440 — deliberately owned by the Linked Projects track.
- AQU-350 — memory/heap loop owns it (cron 96235b6d); AQU-173 — blocked on product decision
  (backfill A/B/C, see AUDIO-GAP-FRO173.md).
- All Medium/Low Todos — below this batch's bar.
- PROTECTED (untracked, owned by the concurrent LP swarm — forbidden to all agents):
  `docs/swarm/LINKEDPROJ-ORCHESTRATION.md`, `docs/swarm/LINKEDPROJ-TRACES.md`.
  Also forbidden: `.worktrees/linked-projects-integration`, `.worktrees/lp-qa-fixes`,
  `.worktrees/fro-476..479` and branches `swarm/linkedproj-*`, `swarm/lp-qa-fixes`, `swarm/fro-476..479`.

## §1 Operating model
- Manual worktrees off the **live integration tip** (never isolation:worktree — stale-base trap).
  sonnet agents, commit-only: no push, no deploy, no promote, no shared dev stack.
- Orchestrator is the only merger/promoter. Every orchestrator git command uses explicit
  `git -C <path>` (PD5 incident rule).
- Claims: orchestrator flips Todo→**Dispatched** (`539bcf69-8c7a-4282-93d0-5631430b66ed`) +
  assigns before spawn; agent advances Dispatched→Fixed on success; failure → orchestrator
  reverts to Todo with a Linear comment.
- Additive conflicts (route tables, switch cases, unions): keep BOTH sides.
- Migrations: D1 is retired — new migrations go to `db/postgres/migrations/` ONLY (next free
  number to be checked at need; LP swarm reserved 0050). Apply-to-live-Neon = SWARM-TODO tag.
- Live-UI QA: centralized singleton after merges (AGENTS.md seeded dev stack); expect port /
  Chrome-profile contention with the LP swarm — stale-vite check first.

## §3 Workstream registry + wave plan
Status: queued | dispatched | review | merged-integration | blocked | fixed

| Wave | WS | FRO | Pri | Branch | Owns (primary surface; ★ = sole owner of hot file) | Status |
|---|---|---|---|---|---|---|
| 1 | access-revoke | 346 | Urgent | swarm/fro-346 | auth-worker membership revoke path + sync-token invalidation; sync-worker token/permission re-check on WS + event write (server side of revocation) | queued |
| 1 | invite-redeem | 347+364 | High | swarm/fro-347-364 | auth-worker invites routes/services (magic-link + link lifecycle), JoinPage client redeem flow | queued |
| 1 | ai-settings | 408 | High | swarm/fro-408 | AI settings panel save path (ProjectSettings AI section ★, useProjectSettings persistence of topK/context/language/validated-only/format) | merged-integration (QA pending) |
| 1 | batch-completion | 361 | High | swarm/fro-361 | src/lib/completion/* batch driver (full-file run loop, error surfacing, resume) | merged-integration (QA pending) |
| 1 | validation-toggle | 348 | High | swarm/fro-348 | EditorTable.tsx ★ validation control hit-targeting (virtualized-row index mapping) | merged-integration (QA pending) |
| 1 | org-scroll | 366 | High | swarm/fro-366 | Org projects list surface (org overview/projects tab scroll model — window scroll rule) | merged-integration (QA pending — live repro unproven) |
| 2 | viewer-enforce | 365 | Urgent | swarm/fro-365 | sync-worker event-write authz (viewer holes) + client affordance gating in editor toolbar (AFTER 346 + 348 merge) | queued |
| 2 | credits-display | 414 | High | swarm/fro-414 | Compute-credits usage panel + its usage endpoint buckets | queued |
| 2 | shared-nav | 416 | High | swarm/fro-416 | "Shared with you" list navigation (dashboard/org shared section click path) | queued |
| 2 | tts-labels | 360 | High | swarm/fro-360 | Cast/voice engine labeling + Generate-audio hover (voice surface) | queued |
| 2 | setup-gating | 334 | High | swarm/fro-334 | Project Setup sidebar role gating (read-only render < required role) | queued |
| 2 | ebible-import | 325 | High | swarm/fro-325 | eBible corpus download path (progress + auth/401 on long download) | queued |

Dependency edges: 365 after 346 (permission stack semantics land first) and after 348 (EditorTable
single-owner). 347+364 merged into one WS (same invite surface). All other pairs file-disjoint;
per wave each ★ file has exactly ONE owner, all others forbidden.

## §M Merge log
(append: date · WS · branch · sha · tsc · vitest)
- 2026-07-06 · **BASELINE @ b686b4e74** (integration worktree): root tsc 0 · vitest **3399 pass / 0 fail (415 files)**.
  Merge gate = ZERO failures (no pre-existing baseline fails this run).
- 2026-07-06 · batch-completion(361) · swarm/fro-361 · 28ac391df (ff) · tsc 0 · vitest 3411/3411 (+12 new).
  Root cause: completeBatch catch handler `return`ed on sub-batch failure → whole chain died silently. Fix:
  1 retry then skip-and-continue; progress store gains failed/finished; banner shows "X of N failed" + dismiss.
  No workers touched. Scope clean (6 files, all owned). Linear: Fixed (pending live-UI QA).
- 2026-07-06 · validation-toggle(348) · swarm/fro-348 · 037496706 (merge b9b9badbd) · tsc 0 · vitest 3415/3415.
  Root cause: NOT the validation pill (id-keyed, sound) — the round multi-select checkbox at the source/target
  divider silently promoted plain clicks to INDEX-based range-select whenever any cell was already selected.
  Fix: range requires explicit Shift-click. AQU-288 batch-validate ruled out. Scope clean (2 files).
  Agent spun off out-of-scope finding (remote WS validate events don't revalidateCellStats) as a task chip.
  Linear: Fixed (pending live-UI QA).
- 2026-07-06 · ai-settings(408) · swarm/fro-408 · a189d45b1 (merge a2f13e096) · gate pending (combined w/ 366).
  Root cause: buildCompletionSettings() in useCompletionSettings.ts hard-coded 8 fields, silently dropped
  top_k/contextSize/useOnlyValidatedExamples/main_chat_language/fewShotExampleFormat on every save; existing
  tests mocked the fn with a spread, hiding it. Fix: merge all fields + success msg enumerates delta + Save
  stays open (explicit "Save and close" added). Scope clean (4 files). Linear: Fixed (pending live-UI QA).
- 2026-07-06 · org-scroll(366) · swarm/fro-366 · 16a9a9e01 (merge 1ccea52e2) · gate pending (combined w/ 408).
  HONEST FINDING: AQU-164 ScrollArea hypothesis REFUTED — lists use plain h-full overflow-y-auto and the chain
  measures correctly. Shipped overscroll-contain (scroll-chaining suspect) + structural regression tests.
  Live repro still unproven → UI-QA MUST test with a 30+-project org. Scope clean (6 files).
  Linear: Fixed (pending live-UI QA — weakest verification of the wave).
- 2026-07-06 · ★ combined gate @ 1ccea52e2 (361+348+408+366 on integration): tsc 0 · vitest **3425/3425 (420 files)**,
  vitest exit code verified 0 (first run's tail clipped the summary — re-ran; fail-loud rule).
- 2026-07-06 · invite-redeem(347+364) · swarm/fro-347-364 · 0723afa7c+0e0c075cf (merge) · root tsc 0 ·
  vitest **3439/3439** · aw tsc 0 · aw **516/516**. AQU-364 root cause: JoinPage collapsed every accept
  failure into "no longer valid" (server redeem verified CORRECT via e2e test) — fix: discriminated
  AcceptResult (used/time_expired/invalid vs unauthorized/network/wrong_email/server). AQU-347: accept-invite
  treated same-user re-redeem as unconditional idempotent success — now idempotent-while-member, 410 after
  removal. Scope clean (7 files). Draft spec amendment in Linear comments (orchestrator to apply).
  Linear: both Fixed (pending live-UI QA).
- 2026-07-06 · credits-display(414) · swarm/fro-414 · 3929def61 (merge) · tsc 0 · vitest 3441/3441 · aw 518/518.
  Root cause: chat.ts records ALL regular-chat spend under hardcoded org 0 → real orgs ledger only agent rows
  (total==agent). Display code was never transposed. Shipped honest labels/tooltips + 4-bucket regression tests;
  deeper org-attribution = follow-up chip (task_7bc10238, needs product decision + creditGuard change).
  Linear: Fixed (pending live-UI QA).
- 2026-07-06 · tts-labels(360) · swarm/fro-360 · b475ca2fe (merge b326cba01) · scope clean (4 files).
  Cast row hardcoded "Clone":"Gemini" → now providerInfo(voice.provider ?? project resolveTtsProvider).
  "Omni voice" string NOT FOUND in tree (likely prod/main divergence — honestly documented, not claimed fixed).
  Follow-up chip: NewVoiceModal still Gemini/Clone-only (task_9cca8fda). Linear: Fixed (pending live-UI QA).
- 2026-07-06 · ebible-import(325) · swarm/fro-325 · ab946de91 (merge ed5bcf09e) · scope clean (2 files).
  Root cause: direct raw.githubusercontent.com fetch, zero retry; 401 is UPSTREAM rate-limiting (no proxy/auth
  of ours involved). Fix: exponential backoff ×4 on 401/403/408/429/5xx + mid-stream drops, 404 non-retry,
  actionable errors via existing importErr. No byte-range resume (deliberate). Linear: Fixed (pending live-UI QA).
- 2026-07-06 · setup-gating(334) · swarm/fro-334 · 9bca50520 (merge 429c5d3d4) · scope clean (4 files).
  New RoleGatedStep wrapper; invites gated 500, instructions/voice 600 (follows shipped AQU-255 floor; spec
  says 500 — divergence documented). CONFIRMED SERVER GAP (flagged, not fixed): AiInstructions/AiModels steps
  persist via IDB-only path, never reach the gated PATCH /settings — follow-up needed. Linear: Fixed (pending QA).
- 2026-07-06 · access-revoke(346) · swarm/fro-346 · 65fcfb1c5 (merge 91b18fccb) · 26 files, +353/−7.
  Enforcement: mint-time (sync-token refuses non-members), write-time (POST /events live membership re-check,
  memoized), live (DO /__member-removed eject + 16-min denylist), SPA forbidden state + member.removed frame.
  Platform-admin exemption stamped via token `src`. docs/SYNC.md section added. Org-member removal does NOT yet
  send DO eject (flagged follow-up). Linear: Fixed (pending live-UI QA).
- 2026-07-06 · ★ FULL COMBINED GATE @ 91b18fccb: root tsc 0 · vitest **3471/3471 (423 files)** · sw tsc 0 +
  **666/666** · aw tsc 0 + **524/524**.
- 2026-07-06 · shared-nav(416) · swarm/fro-416 · c2d2072c5 (merge 90f1cf29b) · TESTS-ONLY (3 files, +93).
  Verdict: no live defect — pre-AQU-474 org-mismatch redirect in ProjectOverview was the root cause, already
  fixed on today's dev by AQU-473/474/475 (other actor). Added click-nav regression tests across all 3 surfaces.
  Spec amendment applied by orchestrator (aquilla-specs f90ff6f). Gate @ 90f1cf29b: tsc 0 · vitest 3474/3474.
  Linear: Fixed (verify status at convergence — one of the two agents' flip was permission-blocked).
- 2026-07-06 · ★ `npm run build` @ 90f1cf29b: exit 0, brand check aquilla OK.
- 2026-07-06 · viewer-enforce(365) · swarm/fro-365 · 74b867712 (merge d95a5e06d) · 9 files (+518/−49).
  Per-hole: #1 translate floor 400 already server-enforced → regression-pinned via real POST /events w/
  viewer token (new sync-worker test); #2/#3 character CRUD = client local-echo bug (localStorage/IDB write
  before doomed 403 PATCH) → gated saveVoice/writeBack/delete/makeDefault at 600 + disabled affordances;
  #4 header AI actions gated in workspace-actions registry; #5 comments + #6 validate already closed
  (AQU-427 / useEditorCapabilities — verified, no change); #7 island returns null below 300.
  Linear: Fixed (pending live-UI QA).
- 2026-07-06 · ★★ FINAL GATE @ d95a5e06d (ALL 13 issues): root tsc 0 · vitest **3489/3489 (424 files)** ·
  sw tsc 0 + **670/670** · aw tsc 0 + **524/524** · `npm run build` exit 0 (brand aquilla OK).
  Baseline was 3399 → +90 net new tests across the batch. Zero migrations added (none needed).
- 2026-07-06 · UI-QA singleton dispatched over integration @ d95a5e06d (alternate ports; punchlist → §PD7).
  Promotion to dev HELD until QA verdict.
- 2026-07-06 · SPEC RECONCILED (orchestrator commits in ~/frontierrnd/aquilla-specs): f90ff6f (AQU-416
  openable-not-just-visible), + AQU-347/364 redeem idempotency & failure classification, + AQU-408
  persistence/save-UX criteria. Spec checkout clean of swarm edits.
- 2026-07-06 · ★ QA VERDICT (punchlist §PD7): PASS 408/348/365/364/416/366/414/360/325 ·
  PARTIAL 346 (reload+403 correct; live WS eject inert — SYNC_WORKER_URL unset in dev / wrong in [env.e2e]) ·
  PARTIAL/FAIL 347 (post-removal refusal works; still-member friendly no-op never reachable — preview 410s
  before accept logic) · FAIL 334 (contributor sees zero gated steps — roleLevel null at render) ·
  361 banner-path PASS / happy-path BLOCKED-env (cell-completion route lacks OPENROUTER_BASE_URL mock override).
  NEW BUGS: viewer can open Import dialog → filed AQU-481 (Todo, this project); SYNC_WORKER_URL config gap +
  347 preview + 334 gate → fixer.
- 2026-07-06 · Linear knock-backs: AQU-334 Fixed→Dispatched, AQU-347 Fixed→Dispatched (comments posted).
  Fixer agent dispatched on swarm/pd7-qa-fixes (off d95a5e06d) for 334-gate / 347-preview / 346-config.
  Promotion still HELD.
- 2026-07-06 · 347 round-2 (orchestrator glue 3a8efa22c): client previewMultiInvite never sent Authorization →
  server fix inert in UI; JWT threaded + JoinPage re-runs preview on session load. Round-3 (1ff00e657):
  Chrome heuristically cached the anonymous 410 → Cache-Control: no-store server + cache:"no-store" client.
  QA re-verify: 334 PASS · 346 PASS (live eject ≤3s) · 347 PASS (default browser, repeatable).
- 2026-07-06 · dev ADVANCED mid-run (LP swarm promoted 4e17594f8+bb5d618f0, 14 commits) → merged dev into
  integration 920c2c2d7; 5 conflicts composed (member.removed + link.upstream-changed frames union;
  membership gate + live-mirror lock both kept in events route; dev-stack SYNC_WORKER_URL --var fixed
  identically by BOTH swarms — union + ENVIRONMENT --var). One cross-swarm test break (408's full mock of
  completion-service vs dev's ab/feedback importing FRONTIER_CHAT_URL) → partial mock 9920e3030.
- 2026-07-06 · ★★★ PROMOTION GATE (composed tree): root tsc 0 · vitest **3532/3532 (429 files)** ·
  sw **722/722** · aw **540/540** · build+brand OK.
- 2026-07-06 · **PROMOTED → dev @ 0189d3971** (--no-ff; dev tip unchanged at merge time; promoted tree
  byte-identical to gated integration).
- 2026-07-06 · FIXER MERGED (ff → d2c7b6fd1): 052c6593d AQU-334 (useProject gains synchronous roleLevel from
  the GET's guaranteed role field; drawer no longer reads stale syncRole cache) · d0d1faeaf AQU-347 (preview
  route optional-auth; still-member redeemer gets 200 usedByCaller:true; legacy single-project preview has the
  same bug → follow-up chip) · d2c7b6fd1 AQU-346 (dev-stack.ts env:→--var [wrangler drops env:], .dev.vars.example
  + [env.e2e] 8789, [env.staging] → api.staging.aquilla.app/sync; prod/dev values were already correct;
  e2e-up.ts has same env: bug → follow-up chip).
  ★ GATE @ d2c7b6fd1: root tsc 0 · vitest 3490/3490 · aw tsc 0 + 528/528 · build OK.
  Linear: 334 + 347 re-flipped to Fixed by fixer. Targeted re-QA (334/347/346-eject) dispatched. Promotion HELD.

## §CLAIMS
(record each Todo→Dispatched flip + any stale-claim decisions)
- 2026-07-06 ~19:46Z · AQU-346, 347, 364, 408, 361, 348, 366 → Dispatched + assigned (orchestrator, pre-spawn). Wave 1.
- 2026-07-06 ~20:13Z · AQU-414, 416, 360, 334, 325 → Dispatched + assigned (orchestrator, pre-spawn). Wave 2
  dispatched early off integration tip f8c8d0891 (5 of 6 wave-1 WS merged; only AQU-365 gated on AQU-346).
- Wave-1 registry statuses: 361/348/408/366/347+364 merged-integration; 346 still in flight (agent nudged once).
- 2026-07-06 ~20:46Z · AQU-365 → Dispatched + assigned; worktree off integration tip 91b18fccb (contains 346+348).
- 2026-07-06 · SPEC: AQU-416 agent edited ~/frontierrnd/aquilla-specs directly (rule breach, caught) — content
  reviewed sound; orchestrator committed it as f90ff6f. Remaining spec drafts (347/364 redeem semantics, 408)
  stay in Linear comments for orchestrator application at promotion.
