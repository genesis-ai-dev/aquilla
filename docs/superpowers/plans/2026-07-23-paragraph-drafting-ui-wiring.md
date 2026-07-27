# Paragraph drafting: finish the UI wiring (Phase 1 follow-through)

Date: 2026-07-23 · Branch: `feat/paragraph-drafting-ui` · Worktree: `/Users/ryderwishart/frontierrnd/aquilla-wt/paragraph-ui`

## Problem

Phase 1 (June 2026) shipped paragraph segmentation at import (`paragraphStart` on
`TranslatableString`/`BulkImportCell`) and `completeParagraph` in `useCompletion`, but:

1. **The flag never reaches the client.** The sync-worker `/import` route's payload
   whitelist (`sync-worker/src/events/import-route.ts` ~line 579) drops the top-level
   `paragraphStart` field. It never lands in an event payload, the `cells` projection,
   `CellRow`, or `CellData`. In production, `deriveParagraphs` therefore only ever splits
   on file boundaries — one giant "paragraph" per file.
2. **No UI.** Nothing shows paragraph boundaries in the editor, and nothing calls
   `completeParagraph` (traced as OPEN `p1-paragraph-ui-wiring` in docs/swarm/TRACES.md:15).

## Approach — no server change, no migration

`cells.metadata` is an explicitly extensible JSONB bucket that already round-trips intact:
the import route whitelists `metadata` through to the `source.cell.create` payload, the
projection stores it, the cells read endpoint returns it parsed, and the client
(`src/lib/sync/cells-read.ts:42-60`) normalizes it onto `CellRow.metadata`.

So: fold `paragraphStart: true` into each cell's `metadata` bag at import build time,
and map it back out in `useCells`' `buildCellData`. Old imports simply have no flag —
paragraph UI stays invisible for them (correct: we don't know their paragraphs), and the
paragraph-draft affordance never appears. Re-importing picks up the feature.

## Global Constraints (binding on every task)

- TypeScript, **no `any`**. Match surrounding style; icons are lucide.
- Do not modify sync-worker, auth-worker, or db/ — this plan is client-only by design.
- Never import `Lock` from lucide (AQU-642: shadows `window.Lock`, crashes editor mount).
  There is a lint guard; do not disable it.
- `paragraphStart` semantics: the FIRST cell of a paragraph carries `paragraphStart: true`;
  membership is derived (scan start→next start / file boundary) via
  `src/lib/parsers/paragraphs.ts` (`deriveParagraphs`, `paragraphGroupForCell`). Never store
  group membership.
- Paragraph visuals and the draft-paragraph affordance must render ONLY on cells where
  `cell.paragraphStart === true`. No flags in a file ⇒ zero visual change (legacy imports
  must look exactly as today).
- Unit tests run in happy-dom (`pnpm test` from the worktree root); follow the
  narrow-single-behavior colocated test-file convention (`EditorTable.<behavior>.test.tsx`).
- React Compiler is ON in the app build but OFF in vitest: when reading versioned stores
  use the existing `readAtVersion()` pattern; do not introduce new version-only deps.
- Verification gate per task: `pnpm exec tsc -b` clean + the named test files green.
- Commit per task on `feat/paragraph-drafting-ui` with message style
  `feat(paragraph-ui): <what> (p1-paragraph-ui-wiring)`.

## Task 1 — Carry `paragraphStart` through metadata to `CellData`

Files: `src/lib/import.ts`, `src/hooks/useCells.ts` (+ colocated tests)

1. In `src/lib/import.ts`, at BOTH sites that currently emit the top-level field
   (`...(str.paragraphStart ? { paragraphStart: true } : {})` — lines ~1241 and ~1926),
   ALSO merge the flag into the cell's `metadata` bag:
   `metadata: { ...(existing ?? {}), paragraphStart: true }` — only when
   `str.paragraphStart` is truthy, and preserving any existing metadata keys (OBS
   attachments use this bag). Keep the top-level field too (other consumers/tests read it).
2. In `src/hooks/useCells.ts`: add `paragraphStart?: boolean` to `CellData`; in
   `buildCellData`, set it from the SOURCE row: `source?.metadata?.paragraphStart === true`
   (strict boolean check — metadata is `Record<string, unknown>`).
3. Tests (this bug escaped at a serialization boundary — test at that level, real shapes):
   - `src/lib/import.paragraph-metadata.test.ts`: run a real parser fixture with paragraphs
     (markdown or plaintext with two paragraphs) through the import cell-building path and
     assert the produced `BulkImportCell`s carry `metadata.paragraphStart === true` on
     exactly the paragraph-start cells, and that a cell with pre-existing metadata keeps
     its other keys. Follow the pattern of `src/lib/import.preview.test.ts` for how to
     drive the builder without network.
   - `src/hooks/useCells.paragraph.test.ts` (or extend an existing useCells unit test):
     `buildCellData` maps `metadata.paragraphStart` → `CellData.paragraphStart`, absent ⇒
     undefined, and non-boolean junk in metadata ⇒ undefined. If `buildCellData` isn't
     exported, test through the smallest public seam that exercises it — do not fork logic.
4. Sanity: `deriveParagraphs` (`src/lib/parsers/paragraphs.ts`) reads `cell.paragraphStart`
   directly off passed cells; with (2) done, `useCompletion.getAllCells()` cells now group
   correctly. No change needed in `useCompletion.ts` — verify with `pnpm test src/hooks/useCompletion.paragraph.test.ts`.

## Task 2 — Make paragraphs visible in the editor

Files: `src/components/EditorTable.tsx` (+ new colocated test)

1. In `renderListItem` (`EditorTable.tsx:~1528-1610`), the per-row wrapper div already
   applies conditional visuals (the amber "no timing" treatment). When
   `cell.paragraphStart === true` AND the row is not the first row of its file, add a
   paragraph-boundary treatment on that wrapper:
   - extra top spacing (e.g. `mt-3`) plus a subtle full-width top rule
     (`border-t border-border/60` on a pseudo/inner element consistent with existing
     Tailwind idiom in the file), and
   - a small muted pilcrow indicator (lucide `Pilcrow` icon, `text-muted-foreground`,
     ~12px) aligned with the 44px action-rail gutter, with `title="New paragraph"`.
   First-of-file paragraph starts get NO extra treatment (the file header already
   delimits them) — avoids a stray rule at the top of every file.
2. Do NOT touch `MemoizedRow`/`EditorRow` memo boundaries for this — the wrapper sits
   outside them by design. Whatever data the wrapper closure needs must come from the
   `CellStoreRow` render-prop `cell` (which is `CellData` and now has `paragraphStart`).
3. Test `src/components/EditorTable.paragraphBoundary.test.tsx`, following
   `EditorTable.editorActions.test.tsx` (mock `@legendapp/list/react` LegendList to render
   all rows): three cells where the third has `paragraphStart: true` ⇒ exactly one
   pilcrow indicator, on the third row; first cell of file with `paragraphStart: true` ⇒
   no indicator; no flags ⇒ zero indicators (legacy regression guard).

## Task 3 — "Draft paragraph" affordance → `completeParagraph`

Files: `src/components/ProjectWorkspace.tsx`, `src/components/EditorTable.tsx` (+ test)

1. `ProjectWorkspace.tsx:~1871`: destructure `completeParagraph` from `useCompletion`;
   add `const handleCompleteParagraph = useCallback((cellId: string) => completeParagraph(cellId), [completeParagraph])`
   and pass it to `<EditorTable ... onCompleteParagraph={handleCompleteParagraph} />`
   alongside the existing `onCompleteSingle`/`onCompleteBatch` (`:~4757`).
2. `EditorTable.tsx`: thread `onCompleteParagraph?: (cellId: string) => void` through
   props → `MemoizedRow` → `EditorRow` (match how `onCompleteSingle` flows; extend the
   memo props interface accordingly).
3. In `EditorRow`'s `CellActionRail` (next to the Sparkles "AI Generate" button,
   ~line 5286-5406): add a `RailButton` with the lucide `PilcrowRight` icon (fallback
   `Pilcrow` if unavailable in the installed lucide version), tooltip "Draft paragraph
   (N cells)". Visibility/enabled gating — ALL of:
   `cell.paragraphStart === true` && `editable` && `!isAnonymous` &&
   `isCompletionConfigured` && `isCompletionAvailable` && `onCompleteParagraph` provided.
4. N (group size): compute with `paragraphGroupForCell(cells, cell.id).length` where
   `cells` is the ordered cell list EditorTable already holds; memoize appropriately so
   it doesn't recompute per keystroke (compute lazily on hover/click path or via
   useMemo keyed on the cells list identity). If the group has only 1 cell, hide the
   button (single-cell Sparkles already covers it).
5. Confirm-before-run: reuse the existing generate-confirm dialog pattern
   (`showGenerateConfirm` around the Sparkles button) with copy
   "Draft this paragraph? N cells will be drafted as one unit. Cells already validated
   are skipped." — respect the same "skip confirm" preference the single-cell path uses
   if one exists; otherwise always confirm.
6. Progress state: `completeParagraph` marks per-cell `completing` entries during its
   fan-out — VERIFY this by reading `useCompletion.ts:595-778`. If (and only if) it does
   not set `completing` for every cell in the group for the duration of the model call,
   add that to the hook (set at start, clear in finally) so the existing per-cell pulsing
   ring shows on all group rows. Errors already surface per-cell via `errors`.
7. Test `src/components/EditorTable.paragraphDraft.test.tsx` (same LegendList-mock
   pattern): (a) button renders only on a `paragraphStart` cell of a multi-cell group and
   click fires `onCompleteParagraph` with that cell id (through the confirm dialog);
   (b) no button on non-start cells; (c) no button when `onCompleteParagraph` absent
   (legacy/prop-less callers compile and render unchanged).

## Task 4 — E2E journey + spec (AGENTS.md gate)

Files: `e2e/JOURNEYS.md`, `e2e/specs/ai/paragraph-draft.smoke.spec.ts` — study
`e2e/specs/ai/completion.smoke.spec.ts` (IDB-injected settings, mock LLM via e2e-up)
and `e2e/specs/editor/ai-completion-dialog.smoke.spec.ts` first, and reuse the
seeded-project helper (`seed-project.ts`) rather than any UI create+import prologue —
BUT the seeded project must contain paragraph-flagged cells; if the standard seed
doesn't, import a small 2-paragraph markdown/plaintext fixture through the existing
import path inside the spec (several specs do this — find one and copy its pattern).

1. Add a JOURNEYS.md row: `| AI | Paragraph pilcrow button drafts all cells of a
   paragraph as one unit (mock LLM) | e2e/specs/ai/paragraph-draft.smoke.spec.ts | |`.
2. Spec: import/seed a doc with 2 paragraphs (≥2 cells each) → paragraph boundary
   indicator visible on the second paragraph's first row → click the pilcrow rail
   button → confirm dialog → accept → assert every cell of that paragraph (and none of
   the other paragraph) receives drafted text.
3. Do NOT run the full smoke suite; run only this spec:
   `pnpm test:e2e e2e/specs/ai/paragraph-draft.smoke.spec.ts` (single stack only — if a
   stack is already up, reuse it; never start a second).
   If the mock-LLM harness cannot express the paragraph cell-id protocol response
   (`<c id=…>` segments), report BLOCKED with what the mock returns instead — do not
   fake the assertion.

## Out of scope (traced follow-ups, do not build)

- Import-preview paragraph indication (PreviewPanel) — follow-up.
- Progressive streaming (`p1-paragraph-streaming`, blocked on Frontier SSE).
- Any settings UI beyond what exists; token-based draftContext budgets (D10 L2).
- Backfilling `paragraphStart` for existing imported projects.
