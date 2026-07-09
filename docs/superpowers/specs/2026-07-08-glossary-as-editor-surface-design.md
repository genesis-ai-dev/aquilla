# Glossary-as-Editor-Surface — Design

**Date:** 2026-07-08
**Status:** Approved for planning
**Author:** Ryder Wishart + Claude

## Problem

Terminology management currently lives in a central column of concept **cards**
([`TerminologyPage.tsx`](../../../src/components/TerminologyPage.tsx), ~1400 lines),
with suggestions and candidates split across a separate review queue and candidates
panel. This surface reads nothing like the main translation experience, so managing a
glossary feels like filling out a form rather than translating.

We want terminology management to feel like **editing a translation**: a source-left /
target-right surface in the main editor area, and the glossary presented as a *file* in
the project — one that a user opens, edits, and grows over time.

## Goals

- A two-column (source ⟶ target) editor-skinned surface for the glossary, in the main
  editor area — not a column of cards.
- The glossary is discoverable and openable **as a file** in the project's file list.
- A single living surface: terms are appended dynamically, suggestions appear inline,
  and lines can be archived (reversible) so they stop being used without being lost.
- Reuse — not rebuild — the existing retrieval (prompt injection), inline blots, and
  violation-checking machinery.

## Non-goals (YAGNI / scope guard)

- **No event-sourcing.** The glossary does not become a real `FileReference` or flow
  through the append-only event log / cells projection.
- **No per-term focus locks** (unlike real cells). Known limitation, see Edge Cases.
- **No new prompt-priority mechanism.** Existing injection already prioritizes terms
  present in the current cell's source.
- **No TipTap-per-row.** Renderings are short; a lightweight inline-editable cell suffices.

## Key decision: lookalike surface over the existing model (Model B)

The glossary keeps its current data model. We build an editor-*looking* surface on top of
it. This keeps blast radius small, preserves the multi-rendering / status / merge /
candidate richness that already works, and — critically — means the retrieval, blot, and
violation code paths need **no changes**, because the underlying `Concept[]` they read is
unchanged.

"It's a file" is therefore a UI/navigation affordance (a pinned pseudo-entry that routes
to the editor), not a literal `FileReference`.

## Data model & sync — unchanged

Glossary remains `ProjectRecord.terminology: Concept[]`
([`src/lib/parsers/types.ts`](../../../src/lib/parsers/types.ts), field `terminology`),
synced via `ProjectWideSettings` the same way as `rules`.

- Read: `useProject`.
- Write: the existing pure helpers in
  [`src/lib/terminology/store.ts`](../../../src/lib/terminology/store.ts) —
  `addConcept`, `updateConcept`, `deleteConcept`, `approveConcept`, `rejectConcept`,
  `mergeConcepts` — followed by `patchProject` / `patchShared`.

A `Concept` is one source headword + `renderings: { rendering, status }[]` where status is
`preferred` | `admitted` | `forbidden`, plus a concept `status` of `active` | `draft` |
`deprecated`.

## Surface: `GlossaryEditor`

A new component that replaces the card body currently rendered by `TerminologyPage` on the
`/project/:id/terminology` route (which already renders inside the `ProjectWorkspace`
shell, per FRO-254). Two-column, editor-skinned, **one row per concept**:

- **Left cell — source headword.** Lightweight inline-editable (contenteditable/input),
  no TipTap. Skinned to match editor row typography/spacing.
- **Right cell — primary rendering.** The primary rendering = the first `preferred`
  rendering; fallback = first rendering; else empty. Inline-editable. Editing it mutates
  that rendering's text, or creates a `preferred` rendering if none exists.
- **Expander** (caret / chip-row on the right): reveals and edits *all* renderings and
  their statuses, reusing the chip + status-select controls already in
  [`TerminologyTermDetail.tsx`](../../../src/components/TerminologyTermDetail.tsx).
  Forbidden renderings render struck-through.
- **Append row.** A persistent empty "new term" row at the bottom; typing source +
  rendering calls `addConcept`. This *is* "dynamically appended to."

### New components

- `GlossaryEditor.tsx` — the two-column surface; reads concepts, owns filter/search,
  "Show archived" toggle, header toolbar (add, import/export, archived toggle), and the
  secondary access to the violations inbox.
- `GlossaryRow.tsx` — one concept row: inline source + primary rendering + expander.

Both target the ~500-line ceiling; `GlossaryEditor` delegates row rendering to
`GlossaryRow`, and reuses `TerminologyTermDetail`'s rendering/status controls in the
expander rather than duplicating them.

## Lifecycle: row states, all inline

One file; concept `status` is rendered as row state. No separate queue/candidates pages.

| Concept status | Row treatment | Actions |
| --- | --- | --- |
| `active` | Normal row | Edit, archive, expand |
| `draft` (suggested) | Ghosted / pending row | Accept (`approveConcept` → active), Dismiss (`rejectConcept`) |
| `deprecated` (archived) | Hidden unless "Show archived"; dimmed when shown | Restore (`updateConcept` → active) |

- **Suggestions** — AI/candidate terms from
  [`src/lib/terminology/candidates.ts`](../../../src/lib/terminology/candidates.ts)
  surface as `draft` pending rows inline, where they'd naturally live.
- **Archive = set `deprecated`.** `deprecated` (and `draft`) concepts are already excluded
  from blots, prompt injection, and rule compilation, so archived terms stop being used
  with zero new plumbing, and Restore is a status flip back to `active`.
- The standalone review-queue and candidates panels are folded into this surface. The
  violations **inbox** ([`TerminologyViolationsInbox.tsx`](../../../src/components/TerminologyViolationsInbox.tsx))
  — cells that violate terms, a distinct concern — remains reachable via a secondary
  toggle/tab so the feature is not lost.

## Navigation: pseudo-file entry

A pinned **"Glossary"** item (BookOpen icon) injected into
[`ExpandableFileList.tsx`](../../../src/components/ExpandableFileList.tsx), rendered above
the grouped real files. It is **not** a `FileReference` — just a pinned row with
selected-state highlighting matching real file rows. Clicking it navigates to
`/project/:id/terminology`; `ProjectWorkspace` renders `GlossaryEditor` in the main editor
area.

## Retrieval / blots / violations — reused as-is

No changes to:

- [`backtranslation-service.ts`](../../../src/lib/completion/backtranslation-service.ts) —
  prompt injection of preferred renderings for source terms present in the cell.
- [`terminology-chip-plugin.ts`](../../../src/lib/richtext/terminology-chip-plugin.ts) —
  inline blots for active concept source-term matches.
- [`compile.ts`](../../../src/lib/terminology/compile.ts) — active concepts → derived
  `TranslationRule`s for the violation surface.

The new surface only *writes* concepts; these paths *read* them.

## Error handling & edge cases

- **Optimistic writes** via existing `patchProject` / `patchShared`. Last-write-wins on
  the settings blob.
- **No per-term focus locks.** Two editors changing the glossary concurrently resolve
  last-write-wins with no "X is editing" affordance. Accepted limitation of Model B vs.
  real cells; flagged so it is a deliberate choice, not an oversight.
- **Incomplete drafts allowed.** A concept cannot be *activated* with an empty source or
  zero renderings (guard in the accept/activate action). `compile.ts` already skips
  non-active concepts, so drafts never leak into enforcement.
- **Duplicate source headwords** keep today's behavior — mergeable via multi-select into
  the existing [`TerminologyMergeDialog.tsx`](../../../src/components/TerminologyMergeDialog.tsx).

## Testing (intent-level, per Rule 9)

- **Row mapping:** a multi-rendering concept shows its `preferred` rendering as the
  primary target; editing the primary mutates that rendering; the expander edits the rest.
- **Lifecycle → enforcement:** archiving a term (set `deprecated`) removes it from
  `compileConceptsToRules` output **and** from blot decorations — asserting archive
  genuinely stops enforcement, not just hides UI. Restore reactivates both.
- **Suggestions:** a `draft` concept renders as a pending row; accept → `active`;
  dismiss removes it.
- **Pseudo-file:** `ExpandableFileList` renders the Glossary entry and selecting it routes
  to the glossary editor.
- **No model regression:** existing terminology / compile / match / blot suites stay green.

## Files touched (anticipated)

- **New:** `src/components/GlossaryEditor.tsx`, `src/components/GlossaryRow.tsx` (+ tests).
- **Modified:** `src/components/ExpandableFileList.tsx` (pinned pseudo-entry),
  `src/components/ProjectWorkspace.tsx` (render `GlossaryEditor` on the terminology route),
  `src/components/TerminologyPage.tsx` (card body retired / repointed).
- **Unchanged (reused):** `store.ts`, `compile.ts`, `match.ts`, `candidates.ts`,
  `csv.ts`, `tbx.ts`, `stats.ts`, `backtranslation-service.ts`,
  `terminology-chip-plugin.ts`, `TerminologyTermDetail.tsx`, `TerminologyMergeDialog.tsx`,
  `TerminologyViolationsInbox.tsx`.
