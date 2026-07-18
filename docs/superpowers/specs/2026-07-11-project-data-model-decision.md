# Project Data Model — Decision: TMS-style base + linking as escape hatch

**Status:** Decision (AQU-538) · 2026-07-11
**Decision owner:** Ryder Wishart
**Resolves:** [AQU-538](https://linear.app/frontierrandd/issue/AQU-538) — "DECISION: project
data model — TMS-style (project = assets, N target languages) vs. language-pair-per-project"
**Reconciles with:** AQU-417 (shared projects), AQU-440 (linked-projects graph UI),
AQU-553 (book/resource-scoped reviewer perms — Crowdin parity)
**Builds on / bounds:** `2026-07-06-linked-projects-provenance-invalidation-design.md` (the
mirror + pin + derive-on-read engine), AD-2/AD-3/AD-9, `auth-worker/src/services/source-linking.ts`.

---

## Decision

Adopt a **hybrid**: make the **TMS-style model the base** — a project is a set of source
assets with **N target-language lanes fanning out from them** — and **keep project linking as
the escape hatch** for the graph-shaped cases the fan model cannot express.

Concretely:

1. **A project holds one source and N target lanes.** The common case (English → 500 sibling
   languages) becomes *one* project, not 500 linked projects. The source exists once.
2. **Linking is demoted, not deleted.** The linked-projects engine (mirror sync, provenance
   pins, derive-on-read invalidation) is retained **only** for the two genuinely graph-shaped
   cases: **chains** (translation-of-translation, e.g. English → French → Chaluba) and
   **external upstreams** (unfoldingWord git adapter). It stops being the mechanism for
   sibling languages.
3. **The TMS model is a generalization of today, so there is no flag-day.** A project with a
   single target lane (`N = 1`) *is* today's language-pair project. Existing projects remain
   valid unchanged; sibling-merge is opportunistic, not forced.

Rationale in one line: **the fan model deletes ~80% of the linking machinery for the 500-of-600
common case, while chains + external upstreams keep the remaining 20% genuinely load-bearing.**

---

## Why: three problems were conflated under "linking"

AQU-538 framed this as "TMS *vs.* language-pair." That is a false binary. Project linking today
solves a **superset** of what the TMS model solves, and only part of the overlap is what TMS
would simplify:

| Problem | Shape | TMS-style solves it? |
| --- | --- | --- |
| **A. Sibling languages** off one source (English → 500 targets, all translating the *same* English) | source → N targets, a **fan** | ✅ this *is* the TMS model |
| **B. Chains** (English → French → Chaluba; a *target* becomes the next hop's *source*) | a **graph** / relay | ❌ pivot/relay is a bolt-on in every TMS |
| **C. External upstreams** (unfoldingWord git; provenance; invalidate-on-upstream-fix) | adapter + propagation | ❌ orthogonal to the data model |

The linked-projects spec already names A vs B as `consumes: 'source'` vs `consumes: 'target'`
(§2). The TMS model **collapses A** and does nothing for B or C. So the real question was never
"TMS or linking" — it was "should case A stop being a linking problem?" Answer: **yes**, because
A is the majority case and the one where linking is most over-engineered.

---

## What the TMS base buys us (case A)

Today, 500 sibling languages = 500 projects, each holding a **mirrored copy** of the English
source kept aligned by the full §5 engine of the linked-projects spec. That machinery exists
*entirely* to make 500 copies behave like one source. In the TMS base the source is **one copy
by construction**, which deletes — for the sibling case only:

- The **mirror sync engine** (§5) — no copies to reconcile.
- **Upstream-fix propagation** for siblings (§5/§8) — every lane reads the same source cell, so
  a fix is visible with **zero events**.
- **Direct staleness** against a mirrored head (§6) — the pin is against the *actual* source
  cell, not a replicated one.
- **Seed-on-link, clone-vs-live, cursor probe** — all moot for siblings.

This is the bulk of the complexity the decision is reacting to, and it evaporates for the
majority case.

## What linking must still do (cases B and C)

- **Chains** are the Come and See low-resource driver: "take the French target, treat it as the
  source for Chaluba." A fan cannot express this — the consumed thing is another lane's
  *validated target*, **merged** with structural fields (timing, cast, refs) from the source
  row (linked-projects spec §2). That merge is real and irreducible.
- **External upstreams** (unfoldingWord) are ordinary upstream projects fed by a git→events
  adapter (spec §11). Orthogonal to the data model.

Both still need a link edge, provenance (`upstream_event_id`), and derive-on-read invalidation.
So linking is **scope-reduced to the rare case**, not retired.

---

## Impact assessment (AQU-538 acceptance criteria)

### Few-shot pollination — *neutral; the original justification mostly dissolves*

The issue's load-bearing objection is "the pair model exists partly to support few-shot." In
practice few-shot retrieval **already keys on `(sourceLang, targetLang)`, not on project** —
see `src/lib/global-tm/index.ts` (`scan(sourceLang, targetLang)`) and the `GlobalTmEntry`
shape. Language-pair-*per-project* was a convenient way to get a clean per-pair corpus, but the
retrieval layer never needed the project to *be* the pair. In a TMS project, few-shot is scoped
**per target lane** — arguably cleaner, since siblings can pollinate each other's context inside
one project instead of across project boundaries. Few-shot survives; the pair-per-project
justification largely goes away.

### Sync / event log — *the one genuinely invasive change; budget for it here*

`cells` is keyed `(project, file, cell, side)` with `side ∈ {source, target}` — **inherently
single-target** (language lives on the *file* today: `sourceLanguage`/`targetLanguage` in
`ProjectFileSummary`). N target lanes means:

- The cell key becomes `(project, file, cell, targetLang)` (source rows unchanged).
- AD-2 last-write-wins-per-cell becomes last-write-wins **per `(cell, lang)`**.
- Touch list: `event-projection.ts`, the `cells` PK/migrations (D1 **and**
  `db/postgres/schema.sql`), `target.cell.commit` (gains a lane/lang), read hooks (`useCells`),
  the editor's "which lane am I committing," `useFocusLock`, and the AD-9 staleness pin
  (`cells.source_event_id`).

Bounded and mechanical, but it is the **center of gravity** of the migration. Treat this as the
one expensive slice.

### Permissions — *moves toward the goal*

Per-language reviewer scoping (AQU-553, "Crowdin parity") is natural in a TMS project — a grant
on a **lane** — and awkward across N sibling projects. Existing `project-permissions` role
floors carry over; lane-scoped grants are additive.

### Existing projects / migration — *no big-bang; N=1 is backward-compatible*

Because a one-lane project *is* today's pair-project, existing projects need **no eager
migration**. Sibling-merge (fold N pair-projects that share a source into one N-lane project) is
**opt-in** and mechanical where the siblings were seeded from a common template — the shared
`cell_id` invariant (linked-projects spec §2) is the join key. Legacy independent projects that
don't share `cell_id` simply stay N=1. Nothing forces a flag-day.

---

## Rollout slices

Each slice ends with a **"How to think about it now"** block — the dev-team mental model
after that slice lands. Finalizing that block (draft → final, reflecting what actually
shipped) is part of every slice's definition of done; it is the paragraph you'd paste into
the team channel when the slice merges. Slice 1's is final; the rest are drafted intent.

### Invariants that hold at every slice

- **Source rows are always lane `''`.** The source exists once, shared by all lanes — that
  is the point of the TMS model. No source-side event or row ever carries a lane.
- **`''` is the default lane** = the file's single configured `targetLanguage`. Every
  pre-lane row and every event without `targetLang` lives there; clients omit `''` on the
  wire so default-lane events stay byte-identical to pre-lane events (idempotency ids,
  replay, history).
- **Lanes ride events, never raw writes.** Anything that creates lane content (UI, merge
  tool, agents) emits `target.cell.*` events with `targetLang` through the normal `/events`
  path — the same front-door rule as the mirror engine and external adapters.
- **AD-2 arbitration is per lane.** The chain slot for a non-default lane is
  lane-qualified (`chain-claims.ts laneQualifiedParentKey`), identically in all four
  arbitration sites: live claim, `isWinningChild` pre-check, `rebuild.ts`, and the bulk
  fold (`scripts/lib/fold-projection.ts`). If you add a fifth site, qualify it.
- **Links are for graphs.** Chains (`consumes: 'target'`) and external upstreams keep the
  mirror + pin + derive-on-read engine unchanged; v1 target-consumption consumes the
  upstream's **default lane** only.

### Slice 1 — schema + projection lanes ✅ SHIPPED (AQU-538)

Migration `0054_cells_target_lang.sql`; `cells` PK is now
`(project_id, file_id, cell_id, side, target_lang)`; `target.cell.create/commit/delete/
reorder` payloads accept optional `targetLang`; lane-qualified chain slots everywhere;
cells reads return `targetLang` and chain-walk per lane. No backfill needed (`''` = every
existing row). Editor/focus-lock threading deliberately deferred to slice 2 — no UI can
produce a non-default lane yet, so live behavior is unchanged.

> **How to think about it now (final):** A target cell is no longer a row — it's a row
> **per lane**, and today exactly one lane (`''`) exists everywhere. If you write SQL
> against `cells`: every INSERT needs `target_lang` (source ⇒ `''`), every `ON CONFLICT`
> must name all five key columns (Postgres errors otherwise), and every target-side
> `WHERE` must make a lane decision — one lane, or deliberately all lanes (structural
> updates like `cell.retime`/`cast.assign` are deliberately all-lane; content updates are
> one-lane). Three rollups are knowingly lane-blind until slice 2: `files` counters sum
> across lanes, `cell_validators` allows one standing validation per (cell, user) across
> all lanes, and `file_section_progress` aggregates cross-lane — all correct at N=1.
> Nothing you do in the UI today can create a second lane; the schema is ahead of the
> product, on purpose.

### Slice 2 — lanes reach the client (add-a-language + editor threading)

- **Lane registry:** a project-level list of target lanes (settings), seeded from the
  file's `targetLanguage`; "Add target language" appends a lane — no new project, no link,
  no copy (the source is already shared).
- **Editor:** an active-lane context; `TranslatedEditor` commits carry `targetLang`;
  `useCells` filters/pairs by `(cellId, lane)`; optimistic updates keyed per lane.
- **Focus locks:** the lease key gains the lane — two translators on different lanes of
  the same cell must not contend.
- **Per-lane validators:** `cell_validators` PK gains the lane (removing the slice-1
  limitation); `files` counters and `file_section_progress` become per-lane rollups with
  cross-lane sums for existing surfaces.
- **Few-shot/completion:** scoped by the active lane's pair — the retrieval layer already
  keys on `(sourceLang, targetLang)`, so this is plumbing, not a rebuild.

> **How to think about it now (final):** "A project view" is now "(project, lane)".
> `ProjectWorkspace` owns `activeLane` (persisted per-project in localStorage); the
> `LaneSwitcher` renders only when `settings.targetLanes` is non-empty, and that registry
> reaches the workspace via `useProject`'s settings overlay (`project.targetLanes`).
> Every target-side surface reads the active lane: `useCells`/`useActiveCellStore` filter
> target rows to the lane before their one-target-per-cell pairing, all commit/validate/
> unvalidate emits carry `targetLang` (omitted for `''`), focus-lock keys are client-composed
> `cellId@lane:<tag>` (the DO treats them as opaque — zero server changes), and completion
> uses the active lane's language. Validators and file/section progress are per-lane in the
> schema (`cell_validators` and `file_section_progress` PKs gained `target_lang`, migration
> 0055); progress reads default to lane `''` so N=1 semantics are byte-identical. `files`
> scalar counters remain cross-lane sums by design. If you add a new target-side surface:
> take the lane from ProjectWorkspace's context, filter rows by `(r.targetLang ?? '') ===
> lane`, and pass `targetLang` on every emit — never assume one target row per cellId.

### Slice 3 — demote sibling linking

New sibling languages are lanes, not linked projects: the create-from-template flow
(AQU-440) offers "add these languages as lanes" for the within-org sibling case; the
mirror engine is no longer the mechanism for `consumes: 'source'` sibling fan-out. The
cross-project `consumes: 'source'` path stays for legacy links until they're merged
(slice 4), then can be retired.

> **How to think about it now (final):** Reach for a **lane**, not a **link**. The
> create-project dialog now actively steers: picking "linked project / use its source"
> (the sibling case) surfaces an "Add as lane on <upstream>" recommendation that PATCHes
> the upstream's `targetLanes` and creates no project at all (maintainer 600+ on the
> upstream; the panel handles the 403 gracefully otherwise). The classic linked-project
> path survives untouched for the two graph-shaped cases: chains (`consumes: 'target'`)
> and external upstreams. Nothing was removed — the sibling fan just stopped being the
> default shape. The mirror engine's remaining scope is chains + external only.

### Slice 4 — opt-in sibling-merge tool

Fold legacy pair-projects that share a `cell_id` lineage (seeded from a common template)
into one N-lane host project: for each donor, emit `target.cell.commit { targetLang }`
events into the host **through the front door** (never raw projection writes), union
members/roles, archive the donor with a pointer to the host. Donor event logs stay intact
as provenance. Non-matching legacy projects simply remain N=1 forever — merging is never
required.

> **How to think about it now (final):** Legacy sibling projects are just N=1 TMS
> projects; the merge tool is a convenience, not a migration. `POST /api/v2/projects/:id/
> merge-sibling { donorProjectId, lane }` (project_lead 500+ on BOTH sides) folds the
> donor's default-lane targets into a new host lane through the front door: real
> `target.cell.commit { targetLang }` events, parent = the host source head, deterministic
> ids so re-runs are no-ops. Only cells sharing `cell_id` with the host merge; the rest
> return as `skipped` — never guessed. The donor is archived with `{ mergedInto,
> mergedLane }` in its settings; its event log stays intact as deep history (the host lane's
> history starts at the merge). If a partner never merges, nothing degrades. No client UI
> yet — server-only; the UI is a follow-up.

### Slice 5 — lane-scoped permissions + oversight (AQU-553)

Lane- and asset-scoped grants (a reviewer sees one lane, or one book) as additive
restrictions on the existing role floors; ProjectOverview grows per-lane progress and
validation counts.

> **How to think about it now (final):** Roles answer "how much"; scopes answer "where".
> `project_member_scopes` (migration 0056) holds additive restrictions — kind `lane` or
> `file`, composing with AND; no rows = unscoped = exactly today. Scopes ride the sync
> token as an optional claim (omitted when empty) and are enforced in sync-worker
> `authorize()` AFTER the role floor, on chain-mutating `target.*` writes and
> validate/unvalidate only — source-side, comments, audio, and file-level events are never
> scope-gated. Leads (500+) are unscopable by rule. Manage scopes per member from the
> share panel's members list (lead+). If you add a new target-side event kind, decide
> explicitly whether it's scope-gated and add it to the authorize matrix + tests.

---

## Reconciliation with related issues

- **AQU-417 (shared-from-other-orgs projects):** unaffected in shape — sharing is per *project*
  regardless of how many lanes it has. A shared N-lane project is one shared entity, which is
  strictly friendlier than sharing N sibling projects.
- **AQU-440 (linked-projects graph UI):** the graph gets **smaller and more honest** — it shows
  only the graph-shaped edges that remain (chains + external upstreams), not 600 sibling edges
  that were really one fan. Sibling fan-out becomes an in-project concern (lane list), not a
  node-and-edge explosion.
- **AQU-553 (book/resource-scoped reviewer perms):** directly enabled — lane-scoped and
  asset-scoped grants are the natural permission surface of the TMS base.

---

## Non-goals / explicitly out of scope

- Not merging the two-projects-per-language split (that's the timeline-file design's job).
- Not building multi-upstream links (still one upstream per link).
- Not retiring the mirror engine — it stays for chains and external upstreams.
- Not a forced migration of existing projects — N=1 backward-compat is the whole point.

---

## The trap this decision avoids

The false binary in the issue title ("TMS *vs.* pair"). We do not have to **replace** linking to
**demote** it. Demoting it captures the simplification for the 500-language common case while
preserving the chain support Come and See cannot ship without.
