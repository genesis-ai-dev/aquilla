# PD6 Swarm — Prototype Debugging wave 6 (AQU-262 / AQU-263 / AQU-264)

Started: 2026-06-10. Orchestrator session: ccd e88edca8.
Scope: **user-specified** — only the three issues filed 2026-06-10 from voice-dictated
walkthrough feedback. NOT a full project drain.

## §0 STOP checklist (the goal) — CONVERGED 2026-06-10, promoted main@9628782

- [x] AQU-262, AQU-263, AQU-264 each at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [x] Integration green: `npx tsc -b --noEmit` + `npx vitest run` (2510/2510); `npm run build` ✓ before promotion.
- [x] `cd auth-worker && npx tsc --noEmit && npm test` green (256/256) — AQU-264 server commit included.
- [x] Each fix verified on the **real dev stack (live UI)** by the singleton UI-QA agent — 262 PASS,
      263 PASS, 264 PARTIAL (description-prefill + sub-600 gating residuals traced in TRACES.md).
- [x] Promoted to main with main's tree clean apart from protected files (--no-ff merge 9628782;
      promoted tree byte-identical to gated tree: `git diff 592ba2c main` empty).
- [x] Every remaining gap traced in `docs/swarm/TRACES.md` (incl. OPEN pd6-syncworker-tsc-debt,
      pre-existing on main, out of wave scope).

## §EXCLUDED

- **Out of user scope** (project has other open issues; user said "swarm these [three]"):
  AQU-183, AQU-173, AQU-209, AQU-259, AQU-257, AQU-193, AQU-246, AQU-221 (Todo/Backlog — untouched).
- **Dispatched locks held by other actors** (skip per claim rule): AQU-179, AQU-227, AQU-224.

## §1 Operating model

- Base: main @ `cfd4470` (clean commit). Integration branch: `swarm/pd6-integration`
  at `.worktrees/pd6-integration`.
- **Protected / forbidden paths** (another actor's uncommitted platform-admin work, live in
  main's working tree right now — no agent may touch):
  - `auth-worker/src/middleware/platform-admin.ts`, `auth-worker/src/routes/admin.ts`,
    `auth-worker/src/routes/org-settings.ts`, `auth-worker/src/routes/orgs.ts`,
    `auth-worker/src/routes/projects-invites.ts`, `auth-worker/src/routes/projects.ts`,
    `auth-worker/src/routes/termbase-subscriptions.ts`,
    `auth-worker/src/services/project-permissions.ts`, `auth-worker/src/types.ts`
  - `src/lib/frontier/admin.ts`, `src/lib/frontier/orgs.ts`, `src/lib/sync/sync-token.ts`,
    `src/pages/AdminConsole.tsx`
  - untracked: `auth-worker/src/__tests__/platform-admin-access.test.ts`, `pd5-settings-text.txt`, `tn-fixture.tsv`
- **CAUTION exception**: `auth-worker/src/services/org-permissions.ts` is also dirty in main
  (hunks at ~L2 and ~L131 only). AQU-264 needs a 3-line change to `getOrgGroupDetail` (~L640,
  disjoint hunks) to return `description`. Agent puts that change in an **isolated, clearly
  labeled commit**; frontend written defensively (works with or without it). At promotion, if
  the dirty file blocks the merge, the server commit is held back on the branch and traced —
  never forced.
- Live-UI verification: singleton UI-QA agent (Step 6) AFTER merges land on integration.
  Worker agents do NOT run the dev stack; they leave SWARM-TODOs.

## §3 Workstream registry + wave plan

Single wave — all three surfaces are file-disjoint, no dependency edges.

| WS | Issue | Branch | Worktree | Owns (surface) | Agent | Status |
|----|-------|--------|----------|----------------|-------|--------|
| WS-262 | AQU-262 tour copy + org-switcher step | `swarm/fro-262` | `.worktrees/fro-262` | `src/components/onboarding/ProductTour.tsx`, `src/components/org/OrgSidebar.tsx`, `src/components/org/OrgSwitcher.tsx`, new test files under those dirs | a615e7d (sonnet) | agent done @743c78e · 13/13 tests · Linear Fixed |
| WS-263 | AQU-263 hero subtitle centering | `swarm/fro-263` | `.worktrees/fro-263` | `src/pages/Homepage/homepage.css`, `src/pages/Homepage/Homepage.tsx` | a6499e4 (sonnet) | agent done @de03d11 (+bonus: `.aq-blitz-verse` same-reset fix) · 2308 tests green · Linear Fixed |
| WS-264 | AQU-264 team edit discoverability + project links | `swarm/fro-264` | `.worktrees/fro-264` | `src/components/org/TeamDetail.tsx`, `src/lib/frontier/teams.ts`; CAUTION isolated commit: `auth-worker/src/services/org-permissions.ts` | a213c8f (sonnet) | agent done @a25de34 (frontend) + db0a005 (server, isolated) · root 2308 + aw 193 tests green · spec members-and-sharing.md updated · Linear Fixed |

Root-cause notes handed to agents (verified by orchestrator pre-dispatch):
- AQU-262: wrong copy at ProductTour.tsx L64-68 ("Switch organizations…" on `account-switcher`
  anchor); AccountSwitcher menu = Preferences / Add another account / Log out / Sign out of all.
  OrgSwitcher (OrgSidebar.tsx L27) has no `data-tour` anchor.
- AQU-263: `.aq-root p { margin: 0 }` reset (homepage.css L110, specificity 0-1-1) beats
  `.aq-hero-sub` (L279, 0-1-0) → `margin: 26px auto 0` never applies → 60ch block pinned left.
  Confirmed live via computed style (margin 0).
- AQU-264: Edit affordance exists (TeamDetail.tsx L191, tiny underlined link, isAdmin ≥600);
  `handleEditOpen` seeds description with "" (L170) and `getOrgGroupDetail` (org-permissions.ts
  L640) doesn't select description → silent wipe on save. Projects rendered as plain spans
  (~L449); org ProjectsList navigates to `/projects/${id}`.

## §M Merge log

(append: date · WS · branch · sha · tsc · vitest)

- 2026-06-10 · WS-262 · swarm/fro-262 @743c78e · FF onto integration (cfd4470→743c78e)
- 2026-06-10 · WS-263 · swarm/fro-263 @de03d11 · merge 43772d3
- 2026-06-10 · WS-264 · swarm/fro-264 @a25de34+db0a005 · merge 6bc4851
- 2026-06-10 · integration @6bc4851 verification: root tsc ✓ · root vitest 2313/2313 ✓ ·
  auth-worker tsc ✓ · auth-worker vitest 177 pass / 16 skip (pre-existing runtime skips,
  none introduced — wave diff contains no skip markers) · build: running
- NOTE: concurrent session active in `.worktrees/aud-*` (sync-worker vitest seen running) —
  shared dev-stack ports + Chrome profile are contended; UI QA must expect possible
  profile-lock interference (see reference_dev_qa_stale_vite_profile_lock).
- 2026-06-10 · integration @6bc4851 build ✓ (brand check OK).
- 2026-06-10 · UI-QA (agent a724ffa, singleton, vite :5174 from pd6 worktree, stale-vite check ✓):
  AQU-262 **PASS** (all items) · AQU-263 **PASS** (all items incl. 390px + `.aq-blitz-verse` bonus) ·
  AQU-264 **PARTIAL** — buttons/name-prefill/rename-persist/project-links PASS; **description-prefill
  not live-verified**: port 8788 was held by the user's main-checkout auth-worker, so browser auth
  traffic hit the OLD server — which incidentally verified the defensive no-wipe PATCH path for real.
  Server half covered by auth-worker unit test (groups-read.test.ts). Sub-600 gating NOT VERIFIED
  (no cheap non-admin login; pre-existing gate, restyle-only risk). Punchlist appended.
- 2026-06-10 · **main advanced under the wave** (other actor committed the platform-admin work,
  ea124f1 et al. — the org-permissions.ts promotion blocker is GONE; commit B no longer held back).
  Merged main into integration → ae514be (org-permissions.ts auto-merged, disjoint hunks).
  Full gate re-running on combined tree before promotion.
- CASUALTY: orchestrator's TRACES.md PD6 append was clobbered by the concurrent session's
  checkout activity — re-append at promotion time.
- 2026-06-10 · gate on ae514be GREEN: root tsc ✓ · vitest 2317/2317 ✓ · aw tsc ✓ · aw vitest
  201/201 ✓ (previous 16 runtime skips ran this time) · build ✓. (First attempt of this gate
  was killed silently at 10min by an erroneous timeout param — re-run with stage markers.)
- 2026-06-10 · FF promotion REFUSED — main advanced again: the concurrent session promoted its
  entire UXA wave (AQU-265…AQU-295, ~60 commits, main → e83c5f8). Overlap check vs wave files:
  **NO_OVERLAP**. Merged main into integration again → d717bbc; re-gating before promotion.
- 2026-06-10 · gate on d717bbc: root tsc ✓ · vitest 2456/2456 ✓ · build ✓ · **aw tsc RED** —
  TS7022 in `auth-worker/src/__tests__/rls-backstop.test.ts` (UXA AQU-289 file, PRE-EXISTING on
  main; their gate evidently skipped `cd auth-worker && tsc`). Surgical orchestrator fix 7cdb650
  (annotate pgliteExec as PgExecutor, 3 lines). aw then GREEN: tsc ✓ · vitest 256/256 ✓.
- 2026-06-10 · second FF attempt REFUSED — main → 03286f1 (UXA still promoting). Delta overlaps
  wave files `org-permissions.ts` (their getOrgPortfolio vs our getOrgGroupDetail — disjoint) and
  `teams.ts` (their Error→UserError sweep vs our interface field — disjoint). Merged main →
  integration @592ba2c, both files auto-merged. Gate (now incl. sync-worker — merge brought
  sync-worker changes from main) running. Promotion will use `--no-ff` merge to end the FF race.

- 2026-06-10 · gate on 592ba2c: root tsc ✓ · vitest 2510/2510 ✓ · aw tsc ✓ · aw vitest 256/256 ✓ ·
  build ✓ · sw vitest 552/552 ✓ · **sw tsc RED — PRE-EXISTING main debt** (test-file-only type
  errors, last touch 4728e9c D1-redact; sync-worker tree byte-identical to main@03286f1; traced
  as pd6-syncworker-tsc-debt, out of wave scope).
- 2026-06-10 · **PROMOTED**: `git merge --no-ff swarm/pd6-integration` → main@9628782 (main still
  at 03286f1 at merge time; promoted tree byte-identical to gated 592ba2c). Wave files only in the
  promotion diff (9 files).
