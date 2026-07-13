# AQU-538 swarm — slices 2–5 of the TMS lane model

**Decision + slice plan:** `docs/superpowers/specs/2026-07-11-project-data-model-decision.md`
**Mode:** Workflow (interactive). Orchestrator = fable (plans/designs/confirms, owns git);
opus agents write complex code (editor, projections); sonnet agents for mechanical slices.
**Integration branch:** `swarm/aqu538-integration` (worktree `.worktrees/swarm-integration`),
based off `claude/aqu-538-project-linking-60wmeq` @ d5544dc.
**Promotion target:** `claude/aqu-538-project-linking-60wmeq` (NOT main, NOT dev — session
branch rules). Orchestrator merges, verifies, promotes, pushes. Agents NEVER push.

## STOP criteria (acceptance checklist)

- [ ] Slice 2: a project can add a second target language; the editor edits either lane
      independently (commits carry `targetLang`); focus locks are per-lane; validators and
      file/section progress are per-lane; few-shot uses the active lane's pair. N=1 projects
      byte-identical (no lane switcher rendered, no behavior change).
- [ ] Slice 3: sibling-language creation offers "add as lane"; mirror engine not invoked for
      the within-project sibling case; chains/external unchanged.
- [ ] Slice 4: opt-in merge tool folds a legacy pair-project into a host lane via front-door
      events; donor archived with pointer; skipped/conflict cells reported.
- [ ] Slice 5: lane-scoped grants restrict target-side writes + review surfaces; unscoped
      grants behave exactly as today.
- [ ] Gates: `tsc -b` clean, root vitest green (modulo pre-existing failures recorded below),
      sync-worker + auth-worker vitest green, `pnpm build` green, e2e smoke for the new
      journeys (env caveat: eBible spec needs external net; 3-shard runs starve this box —
      run failing specs solo to classify).
- [ ] Each slice's "How to think about it now" block finalized in the decision doc.

## Pre-existing failures (NOT ours; do not chase)

- Root vitest: 18 failures on clean tree (AssignModal, ProjectMembersPage, ProposalCard,
  SetupChecklistDrawer, TeamsList, import.test, import.language.test, Settings.test).
- auth-worker: invites.test.ts "still-member preview 410 vs 200".
- e2e: import-dialog-ebible-search needs raw.githubusercontent.com (blocked in sandbox).

## Design decisions (orchestrator-owned; agents implement, don't re-litigate)

1. **Lane registry** = `ProjectWideSettings.targetLanes?: string[]` (BCP-47-ish, opaque),
   in the auth-worker `project_settings` blob (dumb store — new top-level key, no server
   validation needed; MAINTAINER 600 write floor applies). Default absent/[] = "just the
   default lane ''". The default lane is ALWAYS implicit and never stored in the list.
2. **Validate events carry the lane**: `cell.validate` / `cell.unvalidate` payloads gain
   optional `targetLang` (same pattern as commits; '' omitted on wire). `cell_validators`
   gains `target_lang TEXT NOT NULL DEFAULT ''` with PK
   `(project_id, file_id, cell_id, target_lang, username)` — migration 0055 mirrors 0054's
   idempotent PK rebuild. Projection validated/endorsement recomputes stay per-row-correct
   (they already compare `event_id = cells.event_id`); the lane column scopes the
   one-standing-validation-per-user rule per lane. rebuild + fold read lane from payload.
3. **Focus locks**: CLIENT-composed key — the DO's lock map keys on the opaque `cellId`
   string (project-do-handlers.ts), so `useFocusLock` sends `cellId` for the default lane
   (unchanged) and `` `${cellId}@lane:${lane}` `` for non-default lanes. Zero server/DO
   changes; cross-lane clients naturally don't match each other's lock frames.
4. **Per-lane progress**: `file_section_progress` gains `target_lang` in its PK (migration
   0055). Recomputes produce one row set per lane present in the file's target cells (''
   always present; denominator = source rows, lane-independent). Progress READS default to
   `target_lang = ''` — byte-identical semantics for N=1 — with an optional `?lane=` param.
   `files` scalar counters REMAIN cross-lane sums (documented). NOTE: cell_validators' true
   PK today is `(project_id, file_id, cell_id, username)` (schema.sql; the recon's mention
   of event_id in the key was wrong) — 0055 inserts `target_lang` into that key.
5. **Cells read**: `GET .../cells` gains optional `lane=<tag>` query param — filters target
   rows to that lane (source rows always included). Default: all lanes (unchanged).
6. **Active lane on the client**: a lane context owned by the project workspace (whatever
   component owns the cell list; confirmed after recon). Persisted per-project in localStorage.
   The lane switcher renders ONLY when the project has ≥1 non-default lane. All target-side
   emits (commit, validate, unvalidate, delete) read the active lane from context. Default
   lane '' → field omitted (byte-identical wire).
7. **Slice 4 merge mechanism**: server route on sync-worker (project_lead 500+ on BOTH
   projects) that streams donor default-lane target rows as `target.cell.commit
   { targetLang: <lane> }` events into the host through the normal event path (deterministic
   ids `uuidFrom(hash(hostProject + donorEventId))` for idempotent re-runs), keyed by shared
   `cell_id`. Cells missing in host (no shared cell_id) are reported as skipped, never
   guessed. Donor is archived (existing archive flow) with `merged_into` pointer in settings.
8. **Slice 5 scope model**: additive restriction table `project_member_scopes`
   (project, user) → list of `{ kind: 'lane' | 'file', value }`. No rows = unscoped =
   today's behavior. Enforcement: sync-worker authorize gates target-side writes +
   validate/unvalidate against lane scopes; read routes unaffected v1 (privacy is not the
   goal; review-surface filtering is client-side v1). auth-worker CRUD + MembersPanel UI.

## Waves

| Wave | Slice | Status | Agents |
| --- | --- | --- | --- |
| 1 | 2 (client lanes) | RUNNING | A validators+progress (opus) · B lane registry+read param (sonnet) · C editor+context+locks (opus) · D settings UI+few-shot (sonnet) · E e2e journey (sonnet) |
| 2 | 3 (demote linking) | pending | single agent + doc updates |
| 3 | 4 (merge tool) | pending | server (opus) + UI (sonnet) |
| 4 | 5 (lane scopes) | pending | auth-worker (opus) + sync enforcement (opus) + UI (sonnet) |

## Forbidden paths (all agents)

- `db/postgres/schema.sql` PK of `cells` (slice 1 shipped it — don't touch).
- `.husky/*`, `scripts/dev-stack.ts` (orchestrator-owned).
- No `git push`, no branch creation outside your worktree, no Linear writes.
- Do not "fix" the pre-existing failures listed above.

## Merge log

| # | Branch | Verdict | Notes |
| --- | --- | --- | --- |
