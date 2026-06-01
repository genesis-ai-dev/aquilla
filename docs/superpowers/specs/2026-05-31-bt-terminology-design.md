# Back-translation + Terminology — Build Design (2026-05-31)

**Status:** in build (autonomous swarm, wave 1 dispatched 2026-05-31).
**Goal:** Build two aquilla-spec feature areas *fully* in codex-web-app, including the sync-worker event layer (user-authorized). Localization is DEFERRED this round.
**Spec sources:**
- Back-translation: `~/frontierrnd/aquilla-specs/05-user-stories/view-and-correct-backtranslation.md`
- Terminology/glossary: `~/frontierrnd/aquilla-specs/04-features/terminology.md` + `05-user-stories/{add-concept-to-termbase,resolve-terminology-violation,apply-preferred-rendering,lookup-term-while-translating,import-tbx-termbase,export-tbx-termbase}.md`

## Scope decisions (from the user, 2026-05-31)
1. **Include the server event layer.** main is now clean at `aae39b7` (the prior swarm already promoted; the Paratext actor's sync-worker work landed) — so extending `sync-worker/src/events/**` is safe, done *additively*.
2. **Localization deferred.** No `t(key)` shim / copy-clarity pass this round.
3. **Terminology persists & syncs but verdicts are DERIVED on read** (rule engine), matching the user's derived-over-materialized preference. The server-emitted verdict event is explicitly deferred (see Deferred).

---

## Feature 1 — Back-translation (full story)

**Today:** LLM-only client generation; a BT tab in `EditorTable.tsx`; a stale marker; an ephemeral session cache (lost on reload). No statistical glosser, no persistence, no edit, no Polish toggle, no termbase seeding.

**Build:**
- **Client statistical glosser** — `src/lib/completion/bt-glosser.ts`, a deterministic Markov sliding-window n-gram glosser over the project's `(source↔target)` pairs. API (shared contract):
  ```ts
  export interface BtSeed { source: string; target: string; weight: number }
  export interface Glosser { gloss(target: string): string }
  export function buildGlosser(pairs: { source: string; target: string }[], seeds?: BtSeed[]): Glosser
  ```
  `seeds` (default `[]`): corrected BTs & preferred renderings boost (weight>0), forbidden penalize (<0). Decoupled from terminology — seeds arrive as a param.
- **BT tab** — canonical one-paragraph italic layout + "BT" label; auto-generate on target commit/open; inline Edit→Save; Polish toggle (LLM second pass) + "polished" badge; stale marker → Regenerate (harmonize-quiet); role-gate (viewer read-only w/ tooltip, contributor+ edit).
- **Persistence (sync-worker, additive)** — new event kind `cell.backtranslation.set`, payload `{ btText: string; btHtml?: string; targetEventId: string; polished: boolean }`, role contributor (400), non-chain-mutating (does NOT move `cells.event_id`, does NOT touch validations/endorsement). Projects to a new `cell_backtranslations` table; a read route hydrates the latest BT per cell. **Client computes** the BT and emits the event; server persists + fans out.

## Feature 2 — Terminology / Glossary (v1-core)

**Today:** nothing built (only 9 LQA algorithmic checks exist; the glossary data model was never implemented).

**Build (v1-core, demo-true):**
- **Concept model** (`src/lib/terminology/types.ts`): `Concept { id, sourceTerm, renderings:[{rendering, status:'preferred'|'admitted'|'forbidden'}], notes?, status:'active'|'draft'|'deprecated', … }`. Persisted as `ProjectRecord.terminology?: Concept[]`, synced via the existing project-settings path (additive, like `algorithmicChecks`).
- **Compile to rule engine** (`compile.ts`): preferred/admitted → `source-requires-target`; forbidden → `target-forbids`. Violations appear on the existing shared `RuleInfraction` surface. **Verdicts derived on read** — no materialized verdict.
- **Terminology settings page** — CRUD + CSV/TBX import-export.
- **Lookup + apply popover** — standalone component (source term → approved renderings → one-click Apply). Mounted into the editor by the glue wave.
- **Termbase seeds the BT glosser** — preferred=high, admitted=low, forbidden=negative (wired in the glue wave).

## Deferred + TRACED (not silently dropped)
- Server-emitted `cell.terminology.verdict` events (v1 derives client-side instead).
- Org termbase publish/subscribe (cross-project grants + join table).
- Lemmatizer-backed concept-presence at scale (v1 = normalized exact match).
- Concepts-as-cells (per-concept history/validation/comments).
- AI concept suggestions + review queue + merge-duplicates.
- Dictionary entries as a separate file kind (v1 folds notes into concepts).
- Localization (whole area) — separate future effort.

---

## Orchestration
- Fresh integration branch `swarm/integration2` off clean main `aae39b7` (worktree `.worktrees/swarm-integration2`, node_modules symlinked). The old `swarm/integration` @ `9b4529a` is stale (main 60 ahead) — abandoned.
- **Wave 1** (4 parallel sonnet agents, isolated worktrees): `swarm/ws-bt-event`, `swarm/ws-bt-client`, `swarm/ws-term-data`, `swarm/ws-term-ui`. Disjoint ownership: EditorTable.tsx → BT-CLIENT only; types.ts → TERM-DATA only; sync-worker → BT-EVENT only; TERM-UI builds standalone components.
- **Wave 2 (glue + QA)** after wave-1 merges: mount `TermLookupPopover` into the editor; seed the glosser from the termbase; UI-walkthrough QA on a live server.
- Merge each branch → integration2, verify (`npx tsc -b --noEmit`, `npx vitest run`, + sync-worker tests for BT-EVENT), keep-both-sides on conflicts. Promote integration2 → main only when green AND main clean.

## STOP checklist (§0 — done = all green)
- [ ] `npx tsc -b --noEmit` clean (root) · `npx vitest run` green (incl. new tests)
- [ ] `cd sync-worker && npx tsc --noEmit && npm test` green
- [ ] `npm run build` passes
- [ ] **BT demo-true:** statistical BT auto-generates; persists across reload (event); Edit→Save persists; Polish toggle works; stale→regenerate; role-gated
- [ ] **Terminology demo-true:** add/edit/delete concepts; CSV+TBX import/export; violations show on cells; lookup→Apply works; termbase seeds BT
- [ ] every remaining gap has a SWARM-TODO in `docs/swarm/TRACES.md`
