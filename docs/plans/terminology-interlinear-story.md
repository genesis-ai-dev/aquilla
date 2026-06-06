# Terminology Management + Interlinear Back-Translation — Coherent Feature Story

**Date:** 2026-06-06
**Status:** design → issues → swarm
**Author:** orchestration session (feat/dev-db-seed)

## Why this doc exists

The terminology *backend* already exists and is solid (`src/lib/terminology/*`,
`compile.ts` → rule engine, `bt-glosser.ts` Markov aligner, `TerminologyPage.tsx`,
`TermLookupPopover.tsx`). What is missing is the **coherent human story** across the
three personas, and the editor-integration + management surfaces that make it real.
This doc makes the story coherent end-to-end and is the source for the Linear issues.

## Personas (from `~/frontierrnd/aquilla-specs/01-personas-and-roles.md`)

| Persona | Role tier | Relationship to terminology |
|---|---|---|
| **Project Manager** (Wendi) | `project_lead` (500) / `maintainer` (600) | *Owns* the termbase. Imports TBX/CSV, sets preferred/admitted/forbidden, subscribes to org termbases, watches enforcement health. |
| **Team Leader** (Randall) | `project_lead` (500) | *Monitors & triages*. Looks at the management dashboard, sees which terms are being infringed, drills into a term, reassigns/fixes problem cells in the dedicated per-term view. |
| **Translator** (the drafter) | `contributor` (400) | *Consumes & complies*. Sees managed-term chips in the editor while drafting, hovers for approved renderings, one-click applies, sees their own infractions inline. |

### The one coherent loop

1. **PM curates** the termbase (library UI: import, CRUD, status, stats overview).
2. **Translator drafts** — managed terms are *chipped* in the source column; an
   infraction blot appears on the target when a required rendering is missing or a
   forbidden one is present (already wired via `useRules` → `RuleInfraction`).
   The translator hovers the chip → `TermLookupPopover` → **Apply**.
3. **Every commit** recomputes the **statistical back-translation** (glosser, fast,
   no LLM) and the **interlinear alignment** — both already powered by the same
   Markov model — so the BT tab and alignment are always live.
4. **Team Leader monitors** the management dashboard: per-term **enforcement rate**
   (cells where the term appears in source AND an approved rendering is used) vs
   **infringement rate** (appears in source, approved rendering absent or forbidden
   present). Clicks a term → **dedicated per-term view** listing every occurrence
   with a lightweight inline target editor to fix in place.
5. Fixes feed back as glosser seeds (corrected renderings boost; forbidden penalize),
   so the model and the stats self-heal. Derived-on-read throughout — no materialized
   verdicts (matches the project's derived-over-materialized rule).

## Workstreams (→ Linear issues)

### A. Editor: managed-term chips (Tiptap)
- **A1** Tiptap decoration plugin `terminology-chip-plugin.ts` mirroring
  `violation-decoration-plugin.ts`: scans text for active concept `sourceTerm`
  matches, renders a **tiny superscript chip at the top-right of the word** — an
  absolutely-positioned `::after`-style inline widget that does **not** alter line
  height (decoration `widget` with `pointer-events:auto`, `position:relative` host
  span + absolute chip). Status-tinted (preferred=emerald dot, forbidden=red).
- **A2** Mount on the **source** column (`SourceWithTermLookup` already exists) and
  wire the chip click/hover to the existing `TermLookupPopover`; pass `onApply` only
  when the target cell is focused with a selection (per the popover's contract).
- **A3** Target-side: keep using the existing infraction blot (no new node) but make
  the terminology-origin infractions visually distinct (a small term glyph) so the
  translator knows it's a managed-term issue vs a generic rule.

### B. Editor declutter (left gutter + right rail)
- **B1** Audit the left gutter (`EditorTable.tsx` ~2106: number pill + synth badge +
  validation circle) and the right `CellActionRail` (AI generate, play, record, TTS,
  comments, seek). Consolidate into: **primary always-visible** (AI generate,
  validate) + **overflow menu** (`⋯`) for the rest (record/TTS/comments/seek/audio).
  Reduce visual noise; keep the most-used two exposed. Add the term-lookup affordance
  into this overflow rather than adding yet another button.

### C. Terminology library UI + statistics
- **C1** Elevate `TerminologyPage` into a **library** with a stats header:
  total concepts, % enforced, % infringed, top-5 infringed terms. Stats computed
  derived-on-read from the current file/project cells using `compile.ts` rules +
  presence scan (reuse the rule engine, no new persistence).
- **C2** Per-term **dedicated drill-down view**: term metadata + every occurrence
  (cell ref, source snippet, current target, verdict). Each row gets a **lightweight
  inline target editor** (reuse `TranslatedEditor` minimal config — no rail, no
  audio) that commits through the normal target-commit path. This is the "fix without
  the full editor" surface.
- **C3** Manager entry points: link the library from project settings/overview;
  role-gate edit (contributor+ can edit cells in the drill-down; only
  project_lead+ edits the termbase itself).

### D. Interlinear alignment (Markov, confirm/invalidate)
- **D1** Reuse `bt-glosser` model to expose **per-cell word alignments** with a
  confidence score (normalized alignment score). New `src/lib/completion/
  interlinear.ts` building on the existing AlignmentMap; surface only
  **high-confidence** alignments (threshold, tunable).
- **D2** Alignment UI in the BT/expansion tab: source↔target word links rendered as
  faint connectors or a token table; **Confirm** (boost as positive seed) /
  **Invalidate** (drop / negative seed). Confirmations persist as glosser seeds via
  the existing project-settings sync path (additive array, like terminology).
- **D3** Deep-research-informed (see `research-interlinear-backtranslation.md`):
  match Paratext's guess→approve interlinearizer UX as closely as is sensible.

### E. Always-on statistical back-translation
- **E1** Make the statistical BT **recompute on every target commit**, instantly,
  client-side (glosser is already O(short²); memoize the model, rebuild incrementally
  on commit rather than per-keystroke). LLM "Polish" stays an optional second pass —
  the default BT is the fast Markov one. Wire confirmed alignments + corrected BTs +
  termbase statuses as seeds so it sharpens over time.

## Constraints / conventions
- Derived-on-read, never materialize verdicts/stats.
- Chips must NOT change line height (hard requirement from user).
- Additive sync only (project-settings array path), no chain-mutating events for
  stats/alignments.
- Match existing editor conventions; declutter, don't redesign.
- Include a UI-walkthrough QA agent in the swarm (real browser), per project norms.

## Done = ready for QA/alpha
- Chips render on managed terms in the editor without layout shift; hover→Apply works.
- Library shows live enforcement/infringement stats; per-term drill-down edits commit.
- Editor gutter/rail decluttered to primary + overflow.
- Statistical BT auto-updates on commit; interlinear high-confidence alignments
  shown with working Confirm/Invalidate.
- `tsc -b --noEmit` clean, `vitest run` green, `npm run build` passes.
