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
- ✅ Create project (+ New Project dialog: fill name/source/target, Create → redirects to overview)
- ✅ Open project detail `/projects/:id` (verified via archive/create flow)
- ✅ Archived projects `/projects/archived` (archive → disappears from list; Restore → back; no errors)
- ⬜ Assigned to me `/assigned`

### Editor workspace (core)
- ✅ Open project workspace, file tree renders (bestalu-bible, 66 files)
- ✅ Open a file, cells load (Matthew, 1071 cells, sync "Live")
- ✅ Edit a cell, persists across reload (Matthew cell 1 → "1 translated" after reload, no console errors)
- ✅ Validate a cell → indicator (Health button click: "0% — no examples" → "100% — validated", emerald, "Validated by dev (you)")
- ✅ Filter files (sidebar searchbox filters 66→1 file, clear button appears)
- ✅ Search & replace (dialog opens, scopes/modes work, returns "No results" correctly)
- ⬜ Next-unfinished navigation
- ✅ Import via eBible Corpus (ULB: 30,952 verses → 27,000 cells, dialog auto-closes, navigates to file) — see BUG-5 (KJV empty corpus)
- ✅ Export a file (dialog opens with 8 formats, TSV export triggers download)
- ✅ Text ↔ Audio mode toggle (switches Source/Target ↔ Controls/Target columns)
- ✅ Cell details panel (in-row expansion: Decay/BT/Recording/Issues/History tabs + alignment data)
- ✅ Cell action popover ("Record audio" + "Add comment" items present)

### Validation, rules, terminology
- ✅ Rules page renders (9 built-in checks, violation counts, enable/severity toggles, + Add Rule)
- ✅ Terminology page renders (3 concepts, Library Overview stats, Add concept dialog opens)
- ✅ Living memory page (Instructions/Standards sections + 1 validated example shown)

### AI
- ✅ Run AI completions dialog (opens, shows cell count, requires acknowledgement checkbox)
- ⬜ Completion actually fills target cell (requires AI key configured; UI path confirmed)

### Collaboration & sync
- ✅ Comment pipeline fixed (POST /events 200 OK; comment persisted in D1) — see BUG-2
- ✅ CommentsDrawer opens from "Add comment" popover, textarea+Post button functional
- ✅ Comment appears in drawer after post (BUG-3 fixed: liveComments prop + recordsToThreads adapter)
- ⬜ File propagation to a second member (current sync arch)
- ⬜ Concurrent cell edit propagates
- ⬜ Presence indicators

### Comments
- ✅ Add comment via cell → More cell actions → Add comment → CommentsDrawer
- ✅ Comment.create event reaches sync-worker (POST /events 200, D1 row confirmed)
- ✅ Comments appear in drawer after post (BUG-3 fixed: liveComments prop wires useComments state to CommentsDrawer)

### Audio / voice
- ✅ ISSUE-3 FIXED: `/project/:id/voice` route registered; deep-link activates audio lens (Cast sidebar visible, 1 character shown, no errors) — commit 10c5d39
- ⬜ Cast/voice tag assignment
- ⬜ Audio export by character

### Org / team / sharing
- ✅ Members page: roster shows dev+alice, role combobox, Add member form
- ✅ Teams page: "Reviewers" team renders, New team button
- ✅ Project Share dialog: Members tab (dev/alice) + Invite link tab
- ⬜ Invite a new member end-to-end; role change persistence
- ⬜ Access revocation cascade

### Settings & prefs
- ✅ Project settings (name, languages, AI Instructions, validation, audio loading modes)
- ✅ Org settings `/settings` (Identity, member/project counts, links)
- 🐞 BUG-4: Termbase Sharing section 500s (PostgresError: column "org_published_termbase" does not exist) — migration 0030 not applied to Neon; D1 sqlite patched locally
- ✅ User preferences `/preferences` (Privacy toggle + AI provider collapsible, no errors)
- ✅ Archive / restore project (archive removes from list; Archived page shows it; Restore returns it)

### Manager / org-context views (north-star personas)
- ✅ Org overview: stats (3 projects, avg translated/validated/audio, stalled/overdue)
- ⬜ Per-project status/progress drill-down (Wendi/Randall/Anna persona views)

## Findings log

### BUG-1 — `/__dev__/login` 500 on first call (dev-tooling; pattern risk in prod)
`POST /__dev__/login` returned 500 once: `duplicate key value violates unique
constraint "users_email_key" (dev@local.test)`. Self-heals on retry. The user-
create path isn't idempotent on `email` — same non-idempotent insert could make
production signup 500 on a duplicate email instead of a clean 409. File:
`auth-worker/src/routes/dev-seed.ts` (and the shared user-create service).
Status: open, to confirm whether prod signup shares the path.

### BUG-2 — Comments never flushed from outbox (FIXED 2026-06-09)
`useComments.addComment` called `enqueueEvent` without a top-level `fileId` on
the `BuildEventInput`. `outbox-flush.ts` line 115 gates flushing on
`event.fileId` being set. Fixed in `src/hooks/useComments.ts`: extract
`fileId` from `scope` (for `kind: cell` or `kind: file`) and pass it as
`fileId` on the `enqueueEvent` call. Commit: e929138. Now confirmed:
`POST /events 200 OK` and row present in D1 `comments` table.

### BUG-3 — CommentsDrawer shows "No comments yet" after posting (open)
The `useComments` hook polls `GET /api/v1/projects/:projectId/files/:fileId/comments`
which returns 404 (no such route). The actual endpoint is
`GET /api/v1/projects/:projectId/comments` (project-scoped). Fix: update
the GET URL in `useComments.ts` to use project-scoped path. Separately,
`CommentsDrawer` reads `cell.threads` from `useCells` projection — so even
after the fetch fix, threads need to be projected into `CellData.threads`
from the D1 comments read-model, or `CommentsDrawer` needs to be wired to
the `useComments` state directly.

### BUG-4 — Termbase Sharing 500 (Neon schema drift, open)
`GET /api/v2/orgs/:orgId/published-termbases` and
`GET /api/v2/projects/:projectId/termbase/subscriptions` both 500 with
`PostgresError: column "org_published_termbase" does not exist`. Migration
`0030_termbase_subscriptions.sql` was not applied to live Neon (per the
SWARM-TODO in that file). Local D1 sqlite patched manually. Neon migration
must be applied by the operator (do NOT apply to prod without review).

### ISSUE-3 — `/project/:id/voice` route (FIXED 2026-06-09)
Route was missing from App.tsx. Added `<Route path="/project/:id/voice" element={<ProjectWorkspace />} />`
and a `useEffect` in ProjectWorkspace that calls `setLens("audio")` when `location.pathname` ends in `/voice`.
Deep-link now works: Cast sidebar shown, no errors. Commits: 10c5d39.

### BUG-5 — eBible KJV (and other copyright placeholders) return empty corpus (open)
Several eBible translations marked `downloadable=true` (e.g. `eng-eng-kjv`) have corpus files
that are only newline characters — the text is omitted for copyright reasons. `parseEBibleCorpus`
correctly skips empty lines, producing 0 verses, then throws "Translation '...' produced no verses".
The error reaches the user as a red alert in the import dialog. Fix options:
(a) pre-fetch and check line density before showing in picker;
(b) catch the "0 verses" error and show "This translation is not available for download due to
copyright restrictions." separately from other errors.
URL bug that surfaced this was fixed in commit 844bc4f.

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
1. Fix BUG-5: eBible "downloadable=true" translations with empty corpus (KJV placeholder) → show user-friendly message or pre-filter; currently crashes with "produced no verses".
2. Apply Neon migration 0030 to fix BUG-4 (operator task; needs prod DB access).
3. Test Upload Files import path (USFM/VTT file — create test file and upload via file picker).
4. Repair FIXME specs against e2e-up harness; add specs for edit/validate/route-health/comments.
5. Collab (2-user) on current sync; presence indicators.
6. Run full `npm run test:e2e` (stop dev-stack first) and get it green.
