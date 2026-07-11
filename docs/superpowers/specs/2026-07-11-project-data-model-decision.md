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

## Migration path (sketch)

1. **Schema — the invasive slice.** Add the target-lane dimension to `cells` (key becomes
   `(project, file, cell, targetLang)`), extend the projection to last-write-wins per
   `(cell, lang)`, thread `targetLang` through `target.cell.commit`, the editor, focus locks,
   and the AD-9 pin. Ship migrations to **both** D1 and `db/postgres/schema.sql`
   (schema-guard CI). Backfill existing target rows as lane = the project's current
   `targetLanguage`. This alone leaves every existing project working as N=1.
2. **UI — add-a-language.** A project gains "add target language," producing a new lane over
   the existing source assets. Few-shot retrieval is re-scoped per lane (retrieval layer
   already keys on the pair, so this is a scoping change, not a rebuild).
3. **Demote sibling linking.** New sibling languages are lanes, not linked projects. The mirror
   engine is no longer invoked for `consumes: 'source'` **within** a project; it remains for
   chains and external upstreams. (The `consumes: 'source'` cross-project path stays available
   for legacy links until they're merged, then can be retired.)
4. **Opt-in sibling-merge tool.** Fold pair-projects sharing a `cell_id` lineage into one N-lane
   project; leave non-matching legacy projects as N=1.
5. **Keep the linked-projects engine for B + C.** Chains (`consumes: 'target'`) and the
   unfoldingWord adapter (§11) ride the existing mirror + pin + derive-on-read machinery,
   unchanged.

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
