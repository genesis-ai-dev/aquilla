# QA lens — design and ticket breakdown (2026-11-05)

A fourth editor lens beside Text / Media / Transcribe that turns the workspace
into a review surface: the target column on the left, and on the right a
single analysis pane about the focused cell. The pane's first job is to show
the **back-translation** of the focused cell and of every similar target it
lists. Everything else in the pane (issues, smart edits, terminology, parallels)
is already built somewhere in the app and is being brought together, not
written new.

Status: proposal, tickets filed in Linear Triage 2026-11-05 (AQU-2412 … AQU-2420). Author: Ryder (idea), spec drafted with Claude.

## Why

A reviewer today has to open six places to judge one cell: the row's
Back-translation tab, the row's Issues tab, the Check-file drawer, the smart-edit
underline popover, the terminology drill-down, and (for "how did we render this
elsewhere?") search. None of them sit side by side, and nothing in the app
shows "cells that read like this one" at all — that query exists only on the
external Agent API. Consistency work is hard because the evidence is scattered.

## What exists already (reuse, do not rebuild)

| Capability | Where | State |
|---|---|---|
| Lens switch | `src/components/EditorModeToggle.tsx`, `src/hooks/useEditorLensPreference.ts` | `EditorLens = "text" \| "audio" \| "transcribe"`, persisted per project in localStorage. Agent is a destination, not a lens. |
| Text ↔ Media share one mounted `EditorTable` | `ProjectWorkspace.tsx` ~L1602, ~L8257 | Lens switch traces the current cell (AQU-646) and remembers scroll per view. |
| Back-translation of record | `src/lib/completion/bt-record.ts`, `BacktranslationPanel.tsx`, cell fields `backtranslation*` in `useCells.ts` | Per lane, pinned to `targetEventId` + `forText`; `isBtStale` already computed in `EditorTable` (~L7688). File-level read: `GET /api/v1/projects/:p/files/:f/backtranslations?lane=`. Statistical gloss in `bt-glosser.ts`. Bulk hydrate (`fill-missing` / `replace-untouched` / `replace`) in `ProjectWorkspace`. |
| Smart edits | `src/lib/smart-edits/*`, `SmartEditPopover.tsx`, `useSmartEditsPassage` in `EditorTable` (~L3298) | One passage request around the active cell. Tiers: `memory`, `jev`, `llm`, `harmonize` (flag-only). Flags `smartEdits`, `smartEditsLlm`, `harmonizer`. |
| Deterministic "Check file" pass | `CheckFindingsDrawer.tsx`, `runCheck` in `ProjectWorkspace` (~L18454) | Session-local, no fix actions, cites cells; capitalization + term consistency + bible checks. |
| Per-cell rule infractions + waivers | `CellIssuesTab.tsx`, `src/lib/rules/incremental-infractions.ts` (`scanAllCells`) | Lives in the expanded row only. |
| Term equivalents | `EquivalentsPanel.tsx` | Built and tested, **unmounted** (header SWARM-TODO). |
| Lexical similarity | `sync-worker/src/events/scoped-search.ts` `querySimilarSourceCells` + `lib/confidence/lexical-confidence.ts` Jaccard re-rank | Only served by the **external** route `external/similar-route.ts` (PAT auth). No browser-facing route. |
| Branching search (TM-style hits with paired target) | `src/lib/sync/branching-search-read.ts` → `GET /api/v1/projects/:p/branching-search` | Browser-facing, cached in KV, supports `excludeCellId`, `validatedOnly`. |
| Right-side drawer shell | `RightSidebarPanel.tsx` | Per-panel pixel width, own drag handle; deliberately not a nested `ResizablePanelGroup`. |
| Agent changesets with approval gate | `src/lib/agent/`, sync-worker `external/*` | The only sanctioned path for multi-cell AI writes. |

## Design

### Lens

- Add `"qa"` to `EditorLens`. Icon: `ClipboardCheck` (lucide). Label key
  `nav.lens.qa` ("Review"). The stored value is `"qa"`; old stored values keep
  working as today.
- Same mounted `EditorTable`, same cell list, same scroll memory. Switching
  Text → QA keeps the top visible cell (reuse `viewSwitchRebuilds` path).
- Column layout in QA: **target wide on the left**, **source collapsed to a
  narrow peek column** (one-line clamp, click to expand that row). The
  focused cell's full source is also pinned at the top of the analysis pane,
  so a reviewer never loses it. Do not hide the source entirely.
- Row chrome in QA: issue dot, BT-stale dot, smart-edit underlines. Audio
  controls and transcribe chrome hidden.

### Analysis pane (right)

A new component, `QaPane.tsx`, mounted by `ProjectWorkspace` only when
`lens === "qa"`, inside `RightSidebarPanel` (storage key `qa-pane`, default
width 420). It reads the focused cell from the active-cell store and renders
these sections in this order. Each section is its own component so they can
ship independently.

1. **Focused cell header.** Source (full), target (plain text), lane, verse
   ref, validation state.
2. **Back-translation** (the pane's number-one job). Reuse
   `BacktranslationPanel` with the same props the row tab passes today: gloss
   first, AI reading second, provenance and freshness visible, Read back /
   Refresh / edit actions. States:
   - no BT yet → "No back-translation" with a Read back button;
   - stale (`isBtStale`) → amber banner "describes an earlier draft" + Refresh;
   - fresh → reading as-is.
   The row's own Back-translation tab stays; this is the same data, same
   handlers, lifted out of the row.
3. **Similar targets** ("parallels"). Cells in this project whose **source**
   reads most like the focused cell's source, each shown as
   `ref · source snippet · current target · back-translation`. The BT column
   is the point: a reviewer compares renderings by reading them back, not by
   reading the target language. When a hit has no BT, show "No back-translation"
   with a one-click Read back on that hit (writes the normal
   `cell.backtranslation.set` event; nothing special). Stale BTs show the amber
   dot. Click a hit → jump to it in the table (the pane then follows). Sorted by
   similarity score; show the score as a plain word bucket (strong / some), not
   a decimal.
4. **Issues.** The focused cell's active and waived infractions (reuse
   `CellIssuesTab` contents), then smart-edit suggestions for the cell with
   Accept / Dismiss (reuse `SmartEditPopover` body as a list item), then the
   file-level check findings that cite this cell. A "Run check on file" button
   runs the existing `runCheck`.
5. **Terminology.** Key terms found in the focused cell's source (live term
   check) with their approved renderings and whether the target uses one;
   mount `EquivalentsPanel` for the selected term.

Empty pane (no focused cell): file-level summary — count of cells without BT,
stale BT count, open infractions, last check-run time. Each count is a filter
chip that scrolls the table to the first matching cell.

### Similar targets: data path

Two steps so the pane ships without new backend first.

- **v0 (client, no new route):** call the existing browser-facing branching
  search with the focused cell's source text as the query, `excludeCellId`,
  `topK = 10`. It already returns paired targets. Join BTs from the file-level
  back-translations read (same lane) for hits in loaded files; for hits in
  other files, fetch that file's BT rows on demand and cache per
  `(fileId, lane)`.
- **v1 (sync-worker):** add a browser-facing
  `GET /api/v1/projects/:p/similar?cellId=&lane=&limit=` that reuses
  `querySimilarSourceCells` + the Jaccard re-rank and **joins the lane's BT
  row per hit** server-side, so the pane makes one request. Same auth as the
  other `/api/v1/projects/*` reads (sync token). Keep the external route as is.
- Semantic (embedding) similarity is out of scope. The lexical route says so
  in its own header; the pane's empty state should say "no cells share words
  with this one" rather than imply meaning was searched.

### Smart edits across the viewport

Today one passage request fires around the active cell. In QA:

- Request suggestions for every **visible** row (viewport ± one screen),
  debounced 300 ms on scroll settle, **memory and harmonize tiers only**.
  These are algorithmic and cheap. `jev` stays as today; `llm` remains
  click-to-run from the pane and costs credits as now.
- Cache by `(cellId, targetHeadEventId, rulesFingerprint)`. Scrolling back
  never refetches an unchanged cell.
- Underlines render in the target column; the pane lists the focused cell's
  suggestions with Accept / Dismiss. Accept on one cell is a normal
  `target.cell.commit`, as the popover does today.
- Auto-fix never touches validated cells (existing harmonizer rule; keep it).

### Bulk actions

Anything that writes to more than one cell from the pane goes through a
**staged changeset** with the human approval gate, never direct commits:

- "Read back all cells without a BT in this file" → this is a BT write, not a
  target write, so it may use the existing bulk hydrate (`fill-missing`) and
  does not need a changeset.
- "Apply this smart edit everywhere it matches" → changeset.
- "Harmonize this term across the file" → changeset.

### Permissions

The pane is read-mostly. Accept / waive / Read back follow the row's existing
`editable` gate (CONTRIBUTOR+). Viewers get the pane without action buttons.

### Out of scope (deliberately)

Embedding similarity; a QA "score" per cell; anomaly ML; cross-project
parallels; a standalone QA report page (the Progress / Audit surfaces cover
reporting). Mobile layout: QA lens is hidden below `md`, as the pane has no
room; the row tabs keep working.

## Non-negotiables for implementation

- `QaPane` and its sections are their own files under
  `src/components/qa/`. `ProjectWorkspace.tsx` changes are limited to: the lens
  enum, mounting the pane, passing the handlers it already has (BT, check,
  waive, smart-edit feedback, jump-to-cell). No new analysis logic in that file.
- Reads are plain `useState` + race-guarded `useEffect` per AD-3. No
  `useQuery`.
- Every section has a loading, empty and error state and a test for each
  (AGENTS.md rules). The "no BT yet" and "stale BT" states are the ones a
  reviewer meets first; test those against `bt-record` semantics, not against
  string presence.
- The React Compiler drops version-only deps: any read from the active-cell
  store in the pane goes through `readAtVersion()`.

## Ticket breakdown

Tracer-bullet order: each ticket is shippable on its own behind the lens tab,
and the lens is useful after ticket 2.

| # | Linear | Ticket | Scope | Depends on |
|---|---|---|---|---|
| 1 | [AQU-2412](https://linear.app/frontierrandd/issue/AQU-2412) | **QA lens: tab, column flip, empty pane** | Add `"qa"` to `EditorLens`, toggle tab + i18n, QA column layout (target left wide, source peek column), `RightSidebarPanel` shell with the file-level summary as the empty state, lens-switch trace + scroll memory. Hidden below `md`. | — |
| 2 | [AQU-2413](https://linear.app/frontierrandd/issue/AQU-2413) | **QA pane: focused-cell back-translation** | Section 1 + 2. Lift `BacktranslationPanel` into the pane with the row's handlers; no-BT / stale / fresh states; Read back + Refresh from the pane; follows focus. | 1 |
| 3 | [AQU-2416](https://linear.app/frontierrandd/issue/AQU-2416) | **QA pane: similar targets v0 (client)** | Branching search by source text, `excludeCellId`, BT join from file-level BT reads with per-(file, lane) cache, "No back-translation" + Read back per hit, click-to-jump, score buckets. | 2 |
| 4 | [AQU-2414](https://linear.app/frontierrandd/issue/AQU-2414) | **QA pane: issues section** | Cell infractions + waive/unwaive, smart-edit list with Accept/Dismiss, check findings citing the cell, Run-check button. | 1 |
| 5 | [AQU-2415](https://linear.app/frontierrandd/issue/AQU-2415) | **QA pane: terminology section** | Live term check for the focused cell + mount `EquivalentsPanel` (closes its SWARM-TODO). | 1 |
| 6 | [AQU-2417](https://linear.app/frontierrandd/issue/AQU-2417) | **Viewport smart edits (memory + harmonize tiers)** | Visible-rows request on scroll settle, cache by `(cellId, head, rulesFingerprint)`, underlines in QA column; LLM tier stays on click. | 1, 4 |
| 7 | [AQU-2418](https://linear.app/frontierrandd/issue/AQU-2418) | **sync-worker: browser-facing `/similar` with BT join** | New route reusing `querySimilarSourceCells` + Jaccard, lane-aware, BT row joined per hit; pane switches from v0 to this. Preview caveat: route is in sync-worker only, so it IS exercisable on a PR preview. | 3 |
| 8 | [AQU-2419](https://linear.app/frontierrandd/issue/AQU-2419) | **QA bulk actions through changesets** | "Apply everywhere" and "Harmonize term" stage a changeset via the existing engine; approval gate; undo. Bulk Read-back uses existing hydrate. | 4, 5 |
| 9 | [AQU-2420](https://linear.app/frontierrandd/issue/AQU-2420) | **E2E: QA lens journey** | Playwright: open QA lens, focus a cell, see BT and a similar target with its BT, accept one smart edit, waive one issue. Add to `e2e/JOURNEYS.md`. | 2, 3, 4 |

Tickets 3, 4 and 5 are independent of each other and can run in parallel
once 1 lands. Ticket 7 is the only backend work and is optional for the first
usable release.

## Open questions

1. Lane handling for similar targets: show hits from the active lane only, or
   all lanes the caller can see with a lane chip? Default proposal: active
   lane only, with a toggle, because cross-lane BTs compare different
   target languages and that is a different question.
2. Should the source peek column be a user setting (some reviewers want it
   fully hidden)? Proposal: ship fixed, add a View-settings toggle only if
   asked.
3. Name: "QA" or "Review"? The toggle label has room for one short word.
   Proposal: "Review" in the UI, `qa` in code.
