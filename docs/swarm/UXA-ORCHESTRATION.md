# UXA Swarm — UX Journey Audit 2026-06-10 (FRO-265..298)

Started: 2026-06-10. Orchestrator: this session.
Linear project: **UX Journey Audit 2026-06-10** (id `1de02f45-de8d-4ed7-93dc-baf418a9b7c4`)
— created by the orchestrator from `docs/UX-JOURNEY-AUDIT-2026-06-10.md` §5 task plan.
Source of truth for scope = the Linear issues; this file = swarm state. Read both on resume.

## §0 STOP checklist (the goal)

- [ ] Every issue FRO-265..298 at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before each promotion.
- [ ] `cd sync-worker && npx tsc --noEmit && npm test` and same for auth-worker green when touched.
- [ ] Each fix verified on the **real dev stack (live UI)** by the singleton UI-QA agent before trusting Fixed.
- [ ] Promoted to main only with main's tree clean apart from protected files below — never clobbered.
- [ ] Every remaining gap traced in `docs/swarm/TRACES.md`.
- [ ] Audit "what done looks like" (§4 of the audit doc) criteria 1–7 spot-checked at the end.

## §EXCLUDED

- **Dispatched locks held by other actors**: FRO-179 (TN TSV import — likely owns
  `src/lib/import.ts`/`ImportDialog.tsx` vicinity + `tn-fixture.tsv`). Re-check before
  dispatching FRO-277 / FRO-287; if import files turn dirty in main, hold those issues.
- **PD6 swarm** (other session, issues already Fixed but promotion state unknown):
  its branches `swarm/fro-262/263/264` are unmerged in `.worktrees/`. Until PD6 promotes,
  these surfaces are FORBIDDEN to UXA agents: `src/components/onboarding/ProductTour.tsx`,
  `src/components/org/OrgSidebar.tsx`, `src/components/org/OrgSwitcher.tsx`,
  `src/pages/Homepage/*`, `src/components/org/TeamDetail.tsx`, `src/lib/frontier/teams.ts`,
  `auth-worker/src/services/org-permissions.ts`. (Affects FRO-282 /login → schedule late.)
- Other PD-project Todo issues (FRO-173, FRO-183) — different effort, untouched.

## §1 Operating model

- Base: main @ `ea124f1` (clean apart from protected paths). Integration:
  `swarm/uxa-integration` at `.worktrees/uxa-integration`.
- **Protected paths in main's tree** (never touch, never commit): `docs/swarm/TRACES.md`
  (orchestrator-owned appends), untracked `pd5-settings-text.txt`, `tn-fixture.tsv`,
  `docs/swarm/PD6-ORCHESTRATION.md`. The audit doc `docs/UX-JOURNEY-AUDIT-2026-06-10.md`
  is read-only input (orchestrator commits it to the integration branch for agents to read).
- Status pipeline: Todo → **Dispatched** (claim lock, id `539bcf69-8c7a-4282-93d0-5631430b66ed`)
  → Fixed (agent, after verification) → Ready for Review/QA (orchestrator, post-promotion only
  with --deploy; not passed this run → stop at Fixed).
- Agents: sonnet, manual worktrees off live integration tip (NEVER isolation:worktree).
  No push/deploy/promote/dev-stack. SWARM-TODO markers for UI-QA steps.
- Live-UI verification: singleton UI-QA agent after each wave's merges.
- Merge rule: additive conflicts keep both sides (route tables, switch cases, unions).
- Formatter-hook lesson: agents edit files sequentially within their own worktree and verify
  with git diff before committing.

## §3 Workstream registry + wave plan

File-ownership locks (serialize): EditorTable.tsx chain FRO-273 → 274 → 278 → 297;
ProjectWorkspace.tsx chain FRO-273(plumb) → 271 → 287 → 272 → 288 → 296(banner);
App.tsx chain FRO-266 → 270 → 282 → 293; ImportDialog chain FRO-277 → 287 → 267;
auth-worker/projects.ts chain FRO-271 → 283 → 285; invites.ts chain FRO-275 → 283;
sync-worker projection chain FRO-279 → 286 → (272); useCells chain FRO-274 → 280;
useCompletion chain FRO-278 → 292; CommentsPage chain FRO-284 → 295;
fetch-helpers chain FRO-281 → 293; EditorTable strings last: FRO-290 after 297.

| Wave | Issue | Task | Branch | Surface (owns) | Status |
|---|---|---|---|---|---|
| 1 | FRO-268 | 0.3 characterization tests | swarm/fro-268 | worker+src TEST files only | dispatched |
| 1 | FRO-266 | 0.1 error boundary | swarm/fro-266 | App.tsx, main.tsx, new ErrorBoundary, posthog lib | dispatched |
| 1 | FRO-269 | 0.4 consent default | swarm/fro-269 | analytics-consent.ts, useFrontierSession.ts | dispatched |
| 1 | FRO-275 | 1.6 JoinPage error branch | swarm/fro-275 | JoinPage.tsx, lib/sync/invites.ts | dispatched |
| 1 | FRO-276 | 1.7 USFM export honesty | swarm/fro-276 | export-route.ts, usfm-lossless.ts, ExportDialog.tsx | dispatched |
| 1 | FRO-291 | 3.2 destructive confirms | swarm/fro-291 | RulesPage, TerminologyPage, CharacterModal, snapshot UI | dispatched |
| 2 | FRO-265 | 1.3 AI usage caps | | auth-worker chat.ts (+KV/PG counter), ai-error copy | queued |
| 2 | FRO-273 | 1.4 read-only editor | | EditorTable, useProjectPermissions, cloud-projects, PW plumb | queued (dep 268) |
| 2 | FRO-270 | 1.1 /reset-password + 404 | | App.tsx routes, new pages | queued (after 266) |
| 2 | FRO-277 | 1.8 partial-import report | | ImportDialog.tsx | queued (check FRO-179) |
| 2 | FRO-294 | 3.5 deadline TZ | | portfolio.ts | queued |
| 2 | FRO-289 | 2.10 RLS backstop | | db/postgres, db/shim, worker config docs | queued (dep 268) |
| 3 | FRO-274 | 1.5 write failures visible | | EditorTable, outbox.ts, useCells | queued (dep 268, after 273) |
| 3 | FRO-271 | 1.2a truthful delete | | PW delete dialog, projects.ts gate | queued (dep 268, after 273) |
| 3 | FRO-279 | 2.1a validated server | | event-projection.ts, backfill | queued (dep 268) |
| 3 | FRO-283 | 2.4 invite truth | | SharePanel, invites.ts, projects-invites.ts, projects.ts | queued (after 271,275) |
| 3 | FRO-284 | 2.5 mention emails + comment edit/del | | CommentsPage, comment seam, auth-worker email | queued |
| 4 | FRO-278 | 1.9 AI overwrite confirm | | useCompletion, EditorTable generate path | queued (after 274) |
| 4 | FRO-280 | 2.1b validated client | | section-progress, useHealth, useCells | queued (after 279,274) |
| 4 | FRO-287 | 2.8 re-import collision | | import.ts, ImportDialog/PW handleImported | queued (after 277, FRO-179 check) |
| 4 | FRO-285 | 2.6 membership holes | | projects.ts, sync-token.ts, route.ts, SharePanel | queued (dep 268, after 283) |
| 4 | FRO-282 | 2.3 /login | | App.tsx, wizard, Homepage (PD6 gate) | queued (after 270, PD6) |
| 5 | FRO-272 | 1.2b file trash | | sync-worker events, admin.ts, PW sidebar | queued (after 271,279) |
| 5 | FRO-286 | 2.7 retain-validations | | ParallelPassagesPanel, events-emit, projection | queued (dep 279) |
| 5 | FRO-281 | 2.2 error mapping | | lib/sync + lib/frontier helpers + call sites | queued (after most) |
| 5 | FRO-292 | 3.3 AI-drafted distinction | | useCompletion meta, projection, Overview | queued (dep 280, after 278) |
| 5 | FRO-295 | 3.6 comments polish | | CommentsPage | queued (after 284) |
| 6 | FRO-288 | 2.9 batch validate + focus lock | | PW, useFocusLock, EditorTable takeover | queued (after PW chain) |
| 6 | FRO-293 | 3.4 session expiry | | fetch helpers, OrgHome, ProjectsList, App | queued (after 281) |
| 6 | FRO-296 | 3.7 save acks + offline banner | | Settings.tsx, PW banner | queued |
| 6 | FRO-267 | 0.2 funnel instrumentation | | onboarding, ImportDialog, events-emit, outbox | queued (after 277,282) |
| 7 | FRO-297 | 3.8 editor a11y | | EditorTable (last in chain) | queued |
| 7 | FRO-290 | 3.1 copy pass | | broad strings (scheduled last) | queued |
| 7 | FRO-298 | 3.9 dead code | | as discovered | queued (dep 273,283) |

## §M Merge log

(append: date · WS · branch · sha · tsc · vitest)
