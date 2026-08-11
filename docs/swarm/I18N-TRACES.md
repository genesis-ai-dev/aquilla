# I18N swarm traces (AQU-511)

Open TODOs and findings that outlive any single agent's context. Append; don't rewrite.
Companion to `I18N-ORCHESTRATION.md`.

## Open

- **SWARM-TODO (orchestrator, after wave 2):** wire all 9 namespaces into
  `src/lib/i18n/namespaces/index.ts` and their drivers into `scripts/i18n-shots/index.ts`.
  Agents are forbidden from touching these — see the deviation note in I18N-ORCHESTRATION.md.
- **SWARM-TODO (orchestrator, wave 4):** `pnpm i18n:shots` needs the dev stack up
  (`colima start` first — the local Docker runtime is Colima, not Docker Desktop).
- **Handoff, not a TODO:** Task 9 Steps 3–5 need Biblica's Burmese and Patani Malay reviewers.
  This is the release's critical path and it is not engineering work. The swarm hands off
  `i18n-export/*.json`.

## Wave 3 adversarial review — 23 findings (1 real blocker, fixed)

Three read-only lenses over `8405a9ad2..HEAD`. Verdicts: blockers-found, blockers-found,
non-blockers-only. Every finding below was reported with a concrete failure scenario.

**FIXED — the one blocker.** `OutboxInspectorPopover` printed each count twice ("3 3 text
edits") at the edits and comments summary lines: the styled count span was left in place while
the noun was swapped for the `{count} {noun}` template. Caught independently by two lenses.
Fixed in `adf3ab72f` with a regression test verified to fail on the old code.

**OPEN — must land before the catalog goes to translators.** Handing a translator a catalog
with these defects wastes *their* time, and their availability is the release's critical path.

1. **Cross-namespace duplication (109 keys, 48 duplicate-English groups, 37 cross-namespace).**
   The guard only compares each namespace against `common.*`, so it cannot see nine sibling
   namespaces duplicating each other — the exact blind spot of nine agents who could not see
   each other's work. Includes identical auth copy split between `auth.*` and `nav.account.*`
   for the same rendered forms. At 4 locales that is ~437 redundant translations.
2. **Plurals are hardcoded 2-form pairs (61 keys), and Arabic is a shipping locale.** Keys come
   in `.one`/`.many` twins chosen by `count === 1`. Arabic has six plural categories; Thai and
   Burmese have different behaviour again. No translation, however good, can make a 2-form key
   grammatical in Arabic — this is a correctness ceiling, not a quality issue. Must be fixed
   before export or the translation work gets redone.
   Related: `editor.completion.failed`/`failedPartial` are count-bearing with no singular twin.
3. **Sentence fragments glued in JSX** — `JoinPage` (invite summary, plus hardcoded English glue
   and punctuation), `ChapterNavigator` (translated bare noun interpolated into another
   translated sentence — cannot agree in Arabic), `SearchResultsView`. Fixed word order is
   precisely what the context catalog exists to prevent.
4. **Inline emphasis flattened, losing meaning.** `AssignModal` lost `<em>` on "can" in the
   sentence distinguishing assignment from edit rights; `ViewSettingsMenu` lost both `<strong>`
   wrappers on the two conflicting values in the LTR/RTL mismatch banner (the entire point of
   the warning); `HistoryDrawer` lost `font-medium` on the author; `EditorTable` lost two
   `font-medium text-foreground` spans on endorsement count and support percentage;
   `PermissionDeniedAlert` lost `font-medium` on account name and role; `AddFootnoteDialog` and
   `TranslationNotesSidebar` lost `font-mono` (and a contrast bump) on scripture references,
   while the same refs stay monospaced elsewhere in the same UI.
5. **`common.datePlaceholder` is translatable and its context tells translators to reorder to
   day-month-year, but `formatDate`/`parseInputDate` remain hard-locked to en-US.** The context
   invites a change the code cannot honour.
6. **`aria-label` folded into placeholder keys** in `ParallelPassagesPanel` and
   `BibleResourcesPanel`, so accessible names gained a trailing "…" and label/placeholder can no
   longer be translated apart.
7. **`JoinPage` seeds error state from `t()` inside effects with `t` omitted from the dependency
   array** (behind an eslint-disable), freezing those messages in the mount-time locale.
8. **Duplicate accessible name "Language"** on `/preferences/language` (chrome switcher + page
   row). Wave 1 scoped its test with `within(main)` rather than treating it as the bug.
9. **Unnecessary English rewording.** `nav` reworded "Back"/"Forward" → "Go back"/"Go forward"
   and "edit" → "text edit" to satisfy the duplicate lint — but the lint now ships a sanctioned
   escape hatch (`DISTINCT_MEANING`) for exactly this. Revert the copy, use the exception.
   Also four typographic apostrophes (U+2019) became straight quotes, so that panel's typography
   now differs from the rest of the app.

## Findings

### From wave 1

- **`pnpm test` would have launched Chromium.** The plan told `context.test.ts` to import
  `"../../../scripts/i18n-shots"`. That bare specifier resolves to the sibling **file**
  `scripts/i18n-shots.ts` (file beats directory), which calls `main()` at module scope — so the
  test run would have started a browser. Correct import is
  `"../../../scripts/i18n-shots/index"`. Wave-2 agents writing drivers must import shared
  constants from `./shared`, never from the barrel that aggregates them.
- **`scripts/i18n-shots/shared.ts` exists and is not in the plan.** `BASE_URL`, `DEV_PROJECT`,
  `DEV_ORG_ID` and `SurfaceDriver` were locals in the capture CLI; all driver modules need them,
  and importing them from `./index` would make each driver depend on its own aggregator. It is a
  leaf, mirroring `namespaces/types.ts`.
- **`common.search` was deliberately NOT preallocated** — `nav.search` already carries
  "Search", so a `common.search` twin would have made the duplicate guard red on the existing
  catalog. Note the gap this leaves: the guard only compares against `common.*`, so a
  `search.*` key duplicating `nav.search` would NOT be caught. Worth widening if it bites.
- **The switcher was mounted only in AppShell's `!leftDock` branch**, i.e. everywhere except
  ProjectWorkspace — the one screen a translator uses all day. Fixed in `1a4a4d39d`. Root cause
  worth remembering: the plan said "beside the existing account controls in AppShell", but
  AppShell has none of its own; they arrive as `leftDock`/`sidebar` props.
- **Double accessible name on `/preferences`.** The chrome switcher and the page's own row are
  both labelled "Language", so a screen-reader user hears it twice on that page. Wave 1 scoped
  the test with `within(getByRole("main"))` rather than changing either mount. **Still open** —
  cosmetic a11y, not functional; hand to the wave-3 review panel.
- **`pnpm i18n:shots` lost its compile-time totality guarantee.** `DRIVERS` is now
  `Record<string, SurfaceDriver>`, so a missing driver is a runtime TypeError at capture rather
  than a `tsc` error. The two new `context.test.ts` cases catch it in CI first. Do not add a
  second guard if a literal union is ever restored — delete the runtime one instead.
- **Suite flake under load, not a regression:** `src/components/agent/AgentWorkbench.test.tsx`
  failed once on a `waitFor(getAllByText("↩ undone"))`. Zero i18n references in that file or its
  test; passes in isolation and on three subsequent full runs. Consistent with the known
  many-worktrees load flakiness on this box.

- `ScreenshotId` is currently a literal union derived from the `SCREENSHOTS` array, which is
  what makes `DRIVERS: Record<ScreenshotId, …>` enforce driver coverage at compile time.
  Building `SCREENSHOTS` from a `flatMap` over namespace modules widens it to `string` and
  silently drops that enforcement. Task 3 replaces it with `SURFACE_DRIVER_IDS` + two tests.
  **If a later refactor restores a literal union, delete the runtime check rather than keeping
  both** — two guards for one invariant rot apart.
- `src/lib/i18n/screenshots.ts:14-16` documented the capture path as
  `e2e/specs/i18n/catalog-shots.spec.ts`, which does not exist. Real path:
  `scripts/i18n-shots.ts`. Fixed in Task 3 Step 5.
- Worktrees on this repo have no `node_modules`. Root lockfile is byte-identical, so
  `ln -s <root>/node_modules node_modules` is the fast, safe setup.
- `src/lib/i18n/screenshots/` holds the PNGs, so the per-namespace surface *modules* live in
  `src/lib/i18n/namespaces/` (not a `screenshots/` sibling) to avoid mixing TS and binaries
  and to avoid `screenshots.ts` vs `screenshots/` resolution ambiguity.
