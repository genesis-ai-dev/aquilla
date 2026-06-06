# E2E production-readiness test plan & progress

Date started: 2026-06-06 · Branch: `feat/dev-db-seed` · Driver: Claude (loop)

Goal: drive **every** user workflow in the real browser against the seeded dev
stack, fix bugs found, and leave a durable passing Playwright spec for each.
This doc is the living progress tracker — the loop reads it on each resume.

## Environment

- Stack: `pnpm dev` (scripts/dev-stack.ts). Default ports: SPA 5173, identity 8788, sync 8789.
- **Port coexistence (IMPORTANT):** the user runs their OWN dev-stack from the
  `.worktrees/term-integration` worktree, which owns **8788**. `dev-stack.ts`
  calls `freePort()` on its identity port, so launching on the default 8788 would
  KILL their auth-worker (and theirs kills ours back — mutual eviction, observed
  as vite `code=143`). Resolution: ports are now env-overridable. **This loop's
  stack runs on alternate ports — launch with:**
  `DEV_STACK_IDENTITY_PORT=8790 DEV_STACK_SYNC_PORT=8791 pnpm dev` (SPA still 5173,
  which talks to 8790 via the VITE_AUTH_BASE the stack writes). Never use the
  default 8788 while their worktree stack is up.
- Login: navigate `http://127.0.0.1:5173/__dev/login` → user `dev` / `dev`, "Dev Org".
- Rich data: `npm run seed:load -- --local --grant-to dev` grants `dev` OWNER on the
  8 seeded prod projects (BCS/Chosen). They are NOT in "Dev Org", so they don't show
  in the org-scoped `/projects` list — open them directly by id, e.g.
  `/project/41ee4729-6862-51b1-b89c-47401d1a7850` (bestalu-bible, 66 files).
- Logs: `.dev-stack-logs/identity.log`, `.dev-stack-logs/sync.log`.

### Seeded projects (dev owns all)

| id | name | shape |
| --- | --- | --- |
| 41ee4729-6862-51b1-b89c-47401d1a7850 | bestalu-bible | 66 files, 31k cells |
| 5a75dd78-f4a6-5454-81c6-8a7dc7efd9aa | suvvali-bible | 66 files, 31k cells |
| 9f9c4294-e23c-5391-b2da-f790c69aa6a9 | tamil-alignment | 66 files, alignment |
| f7818397-91e8-53de-abb5-6126c566e9e2 | nagamese-pilgrims-progress | 28 files |
| 6ecec038-70e8-5e62-8087-8afbe1bc3548 | hindi-pilgrims-progress | 1 file, 1.4k cells |
| d51f82a7-a50c-5897-9c38-b4a2272c370a | commentaries-test | 1 file, 66 cells |
| d04c4f29-a7cb-55e3-9c2b-5fe5eedcfbd2 | audio-dubbing-playground | 8 files |
| 40be0415-2364-5ec8-8c5d-e2ad6d99e760 | Copy-of-test-matthew-audio-dubbing | 3 files |

## Testing approach

Per `e2e/JOURNEYS.md`: API-first setup + UI verification; reuse page-objects;
each `test()` resets and is independent; `*.smoke.spec.ts` for the <2min gate.
Current specs target the RETIRED frontier-server/y-partyserver — several are
FIXME'd. Part of this effort is porting them to the current auth-worker/
sync-worker + D1-event-log + ProjectSync DO architecture.

For each workflow: (1) drive it in the browser, (2) record pass/fail + evidence
+ console check, (3) fix any bug, (4) add/repair a Playwright spec, (5) tick it.

## Workflow checklist

Legend: ⬜ untested · 🔄 in progress · ✅ browser-verified + spec · 🐞 bug found

### Auth & onboarding
- ✅ Dev auto-login lands logged-in session (browser-verified) — see BUG-1 (500 on first call)
- ⬜ Onboarding wizard first-run → dashboard
- ⬜ Real signup / login UI flow
- ⬜ Account switcher (multi-account)
- ⬜ Join via invite link `/join/:token`

### Project dashboard & nav
- ✅ Projects list renders (Dev Project) — see ISSUE-2 (cross-org membership not listed)
- ⬜ Overview/Org home `/`
- ⬜ Create project (+ New Project)
- ⬜ Open project detail `/projects/:id`
- ⬜ Archived projects `/projects/archived` (view, restore)
- ⬜ Assigned to me `/assigned`

### Editor workspace (core)
- ✅ Open project workspace, file tree renders (bestalu-bible, 66 files)
- ✅ Open a file, cells load (Matthew, 1071 cells, sync "Live")
- ✅ Edit a cell, persists across reload (Matthew cell 1 → "1 translated" after reload, no console errors)
- ✅ Validate a cell → indicator (Health button click: "0% — no examples" → "100% — validated", emerald, "Validated by dev (you)")
- ⬜ Filter files (sidebar search)
- ⬜ Search & replace
- ⬜ Next-unfinished navigation
- ⬜ Import a file (USFM/Paratext/markdown/VTT)
- ⬜ Export a file (each format)
- ⬜ Text ↔ Audio mode toggle

### Validation, rules, terminology
- ⬜ Rules page: enable rule → violation surfaces
- ⬜ Terminology page: add/manage glossary
- ⬜ Living memory page

### AI
- ⬜ Completion (sparkle) fills target cell

### Collaboration & sync
- ⬜ File propagation to a second member (current sync arch)
- ⬜ Concurrent cell edit propagates
- ⬜ Presence indicators

### Comments
- ⬜ Add / edit / resolve comment; cell indicator

### Audio / voice
- ⬜ Voice studio (`/project/:id/voice`)
- ⬜ Cast/voice tag assignment
- ⬜ Audio export by character

### Org / team / sharing
- ⬜ Members page: invite, role change, remove
- ⬜ Teams: create, add member, attach project (max-wins)
- ⬜ Project Share dialog → invite link
- ⬜ Access revocation cascade

### Settings & prefs
- ⬜ Project settings (name, languages, AI config)
- ⬜ Org settings `/settings`
- ⬜ User preferences `/preferences`
- ⬜ Archive / restore project

### Manager / org-context views (north-star personas)
- ⬜ Org overview metrics for owner (Wendi/Randall/Anna)
- ⬜ Per-project status/progress legibility

## Findings log

### BUG-1 — `/__dev__/login` 500 on first call (dev-tooling; pattern risk in prod)
`POST /__dev__/login` returned 500 once: `duplicate key value violates unique
constraint "users_email_key" (dev@local.test)`. Self-heals on retry. The user-
create path isn't idempotent on `email` — same non-idempotent insert could make
production signup 500 on a duplicate email instead of a clean 409. File:
`auth-worker/src/routes/dev-seed.ts` (and the shared user-create service).
Status: open, to confirm whether prod signup shares the path.

### ISSUE-3 — `/project/:id/voice` route does not match the router
Vite logs `No routes matched location "/project/<id>/voice"` and the page renders
an empty heading (no crash). The verify-dev-change skill lists `/voice` as a
route and the workspace toolbar has a "Voice" button — so either the route was
removed/renamed or the toolbar button points elsewhere (modal?). Voice/audio
dubbing is a real workflow; confirm where it lives. Status: open, to investigate.

### ISSUE-2 — projects you're a member of in another org don't appear in `/projects`
`/projects` is org-scoped to the active org. A user granted direct
`project_members` on a project in a different org sees nothing in the list and
must deep-link. May be by-design (org switcher), but worth confirming there's a
discoverable path ("shared with me"?). Status: open question, not yet a bug.

## Durable spec harness (e2e/)

`scripts/e2e-up.ts` IS already ported to the current arch — boots auth-worker
(identity :8787) + sync-worker (:8788) on a shared **local D1** (`--persist-to
.wrangler-e2e-state`, `wrangler d1 migrations apply aquilla-db --local`), serves
`/__test__/reset`, seeds alice/bob/carol. (The "frontier-server" wording is stale
README text only.) **Port conflict:** e2e-up uses :8788 which the running
dev-stack also uses (identity) → can't run the durable suite while dev-stack is
up. Alternate: stop dev-stack before `npm run test:e2e[:smoke]`.

Plan: (a) manual browser exploration on dev-stack + rich seed → find bugs/confirm
flows; (b) lock each flow with a Playwright spec on the e2e-up harness using the
existing page objects (Workspace.editCell/validateCell/importFile, Dashboard).
Known FIXME specs to repair: orgs/members.smoke, rules/violation.smoke,
collab/file-propagation.smoke, collab/concurrent-edit.smoke.

Validate UX note for specs: a single click on `button[title*='Health']` validates
the cell (title → "100% — validated"); no separate Validate button in that path.

## Verified-good so far
- Seed → UI integration: 8 prod projects load with full file trees + cells.
- Current sync stack is live ("Live — syncing to Cloudflare"), not the retired path.
- **Route-health sweep (15/15 clean):** `/`, `/projects`, `/assigned`,
  `/projects/archived`, `/teams`, `/members`, `/settings`, `/preferences`, and
  project `/`, `/settings`, `/rules`, `/terminology`, `/comments`, `/memory`,
  `/voice` all render with NO console/page errors and no crash boundary, against
  the rich bestalu-bible project. Headings confirmed (Translation Rules,
  Terminology, Living Memory, Organization settings, etc.).

## Next up (loop continues here)
1. Comments: add → resolve on a cell; cell indicator. Search&replace; file filter.
2. Import (USFM/VTT) + export per format on a scratch project.
3. Repair FIXME specs against e2e-up harness; add specs for edit/validate/route-health.
4. Org/teams/members/sharing + access cascade; collab (2-user) on current sync.
5. Audio/voice studio; settings persistence; manager/org-overview metrics.
6. Run full `npm run test:e2e` (stop dev-stack first) and get it green.
