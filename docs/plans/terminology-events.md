# Terminology on the event log (AQU-1006 follow-up)

Fixes three prod defects found in the 2026-09-04 PAB-NLP demo and closes the
architectural gap that caused the worst of them.

## Why

Terminology is the only major write surface that never joined AD-2. Concepts
live in the `project_settings` JSON blob and every add/edit PATCHes the WHOLE
`terminology` array, rebuilt from the writer's stale in-memory snapshot
(`ProjectWorkspace.tsx:4985`, `TerminologyPage.tsx:938/982/1014`).
`useProjectSettings` re-probes the server before writing and merges
`{...fresh.settings, ...partial}` — a KEY-level merge, so a fresh
`terminology` array is overwritten wholesale by a stale one. Two people adding
terms in the same minute silently destroy each other's entries, with no 409 and
no conflict banner. Observed live: five attendees added terms, one survived.

Putting concepts on the event log makes the clobber structurally impossible
(per-concept writes, no whole-array replace), and delivers the audit log,
realtime fanout and history the blob can never have.

## Slices

### 1. `term.*` event kinds + `concepts` projection
Model on `comment.*` — project-scoped (`fileId: "__project__"`),
non-chain-mutating, own projection table. NOT the cell head-CAS path.

- `sync-worker/src/events/types.ts`: add `term.create | term.update |
  term.delete | term.approve | term.reject`.
- `sync-worker/src/events/handlers/term-events.ts`: new, cloned from
  `comment-events.ts` (events INSERT + projector call, no chain guard).
- `db/postgres/schema.sql` + a migration: `concepts` table
  (`concept_id` PK, `project_id`, `source_term`, `renderings` JSONB,
  `notes`, `status`, `case_sensitive`, `created_by`, `created_at`,
  `updated_at`, `deleted_at`).
- `event-projection.ts`: projection stmts. `term.update` merges by
  `concept_id` — last-writer-wins PER CONCEPT, never per array.
- Authorization: reuse the org's `termbaseEditMinRole` floor
  (`auth-worker/src/routes/project-settings.ts:137` carve-out) via
  `events/role-policy.ts`, so the existing permission model is preserved
  rather than forked.

### 2. Read path + migration off the blob
- `src/lib/sync/concepts-read.ts` + `useConcepts` hook (thin-client HTTP read,
  race-guarded `useEffect`, matching the other `*-read.ts` modules).
- Typed emitters in `events-emit.ts`; writes go through the outbox.
- CLEAN CUTOVER (Ryder, 2026-09-04): no dual-read period. The settings
  `terminology` key is retired in this same change; nothing reads the blob
  after this branch lands.
- One-shot per-project migration, server-side and idempotent: emit
  `term.create` per blob concept under a project-scoped advisory lock, then
  clear the settings key in the same transaction. Existing concepts are
  preserved (the Patani project has real terms); they are simply not
  depended on, which is what makes the hard cutover safe.
- `useRules` (`src/hooks/useRules.ts:113`) reads concepts from the hook instead
  of `project.terminology`; `compileConceptsToRules` is unchanged.

RISK: the migration is the sharp edge. Idempotent, server-side, one project
-scoped advisory lock — never "first client to load wins". With the clean
cutover there is no fallback to mask a partial migration, so it must be
all-or-nothing per project.

### 3. Suggestion vs. auto-approve at creation
The state machine already exists (`draft` -> `active`, `approveConcept`,
`TerminologyReviewQueue`). Missing is the choice at creation time.

- `AddConceptPopover`: a toggle, "Suggest for review" vs "Add and approve".
- Default and disabled-state come from the caller's resolved role against
  `termbaseEditMinRole` — below the floor, the toggle is locked to "suggest".
  This reuses `addConceptBlockedReason`'s existing resolution
  (`ProjectWorkspace.tsx:5016`) rather than adding a second permission path.
- FIXES the "I added a term and nothing happened" confusion: a concept with no
  rendering compiles to zero rules (`compile.ts:43-53`), so it can never blot.
  The toggle makes "this is a suggestion, not yet enforced" explicit, and the
  popover should say so when no rendering is given.

### 4. Term detail: editable renderings
`TerminologyTermDetail.tsx` currently renders renderings read-only.
- Add / remove a rendering; change status among preferred / admitted /
  forbidden. Each is a `term.update` event.
- Status changes flow straight through `compileConceptsToRules` (approved ->
  `source-requires-target`, forbidden -> `target-forbids`), so enforcement
  follows with no rule-engine change.

### 5. Server-side occurrence query
`TerminologyPage.tsx:800-815` loads EVERY cell of EVERY file
(`useProjectCells` -> `flatMap`) to count occurrences client-side. On the 31k
-cell Bible that is the whole corpus in memory before the page paints.

- New sync-worker route: occurrences for a concept's compiled pattern, paged,
  returning `{ total, enforced, infringed, rows }`. Build on
  `events/scoped-search.ts` (FTS already exists) with a regex/ILIKE refinement
  pass for wildcard terms.
- Detail page and `LibraryStatsHeader` read counts from the endpoint; the
  corpus-wide `useProjectCells` load is dropped.
- Candidate mining (`candidateCorpus`) still needs bulk text — keep it on the
  existing path but load it ONLY when the candidates tab is open.

### 6. Highlight default
`useTargetKeyTermHighlightPreference.ts:10` — `normalizeMode` fallback
`"never"` -> `"focused"`. Per-project localStorage, so this only affects
users who have never set it.

## Verification
- Unit: projection merge (two concurrent `term.create`s both survive — the
  regression test for the prod bug), migration idempotency, permission floor,
  occurrence-count parity vs the current client-side scan on a fixture.
- E2E: two browser contexts add terms simultaneously; both persist.
  This is the journey that would have caught the demo failure.
- Existing terminology suites (`terminology.test.ts`, `store.test.ts`,
  `compile.ts` consumers) must stay green unchanged — the data model is
  unchanged, only its transport.

## Sequencing
One branch, all six slices, per Ryder's call. Slices 1-2 are the load-bearing
ones and land first; 3, 4, 6 are independent and can go in any order; 5 is
separable if the branch gets too big to review.

NOTE: prod continues to lose terminology entries until this lands. If an ETT
training session is scheduled before then, cherry-pick a server-side
concept-level merge in `project-settings.ts` as a stopgap.
