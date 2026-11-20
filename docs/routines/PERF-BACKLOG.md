# Performance backlog — what the AQU-2654 pass measured and did not fix

The nightly routine (`.claude/commands/perf-nightly.md`, Step 4) picks its target from the
benchmark report first. When the report has no regression and no number over the "instant"
line, it takes the next item here. Each item was measured or traced on 2026-11-19; **re-measure
before you fix it**, name the mechanism, and delete the item in the PR that fixes it.

Rules for this file: an item names a file, a mechanism in one sentence, and the number that
shows it. Add an item when a run finds something it will not fix that night. Do not add wishes.

## Editor — commits per action

Measured after the pass: one cell commit is 8 workspace renders (target 3); one activation is
13–14 React commits (target 6).

1. **One shared outbox snapshot.** About 12 hooks subscribe to outbox changes and each re-reads
   IndexedDB per notification (`peekOutboxBatch(2000)` in `src/hooks/useActiveCellStore.ts`; the
   `OutboxProvider`, `usePendingOutboxRecords`, `useForbiddenOutboxRecords`,
   `useRefusedFileEvents`, `useRefusedComments`). The workspace subscribes to the whole outbox
   context, which is 3–4 of its renders per commit. One store, one read per notification,
   selectors for consumers. 26 test files mock the outbox per hook — do it in steps.
   *Step 1 done (2026-11-19):* the provider publishes counts and both record lists from one read
   in one update (`src/hooks/useOutboxSnapshot.ts`), and the workspace's stats overlay takes its
   records from that snapshot instead of reading again. At 1× CPU a commit went from 9 workspace
   renders to 8. *Next:* `useActiveCellStore.ts` still does its own `peekOutboxBatch(2000)` per
   notification, and its `setPendingOverlay` lands as a separate render; then the
   forbidden/refused readers.
   *Step 2 tried and reverted (2026-11-20, failure 1 of 3 for this target):* one shared read
   per notification, delivered to the provider's snapshot and the cell store's pending state
   in one task (a `subscribeToOutboxRecords` module over `peekOutboxBatch(2000)`; both test
   suites passed unchanged). It does what it says: the ack's two updates always land in one
   render. But under the benchmark's 4× throttle they already fell into one batch most runs,
   so `plain.commit.workspaceRenders` stayed 7 → 7 and `glossary` 7 → 7 (1× CPU: 7, 8, 7 on
   `dev` against 6 with the change, one sample). Below the 10% bar, so it did not ship. Do
   not retry it alone: it only clears the bar together with item 2, whose extra render is
   the one the throttle never hides.
2. **Audit stats are workspace state pushed into the store by an effect** (`store.setRuntime`),
   and `useSyncExternalStore`'s consistency check forces a second render. Apply them in the same
   task as their cause, or keep them out of workspace state.
   *Traced 2026-11-20 (store emits logged in the unminified build):* this is the one
   workspace render per commit that is its own task at every throttle. The enqueue renders
   the workspace; that render derives the pending-validation overlay
   (`useCellsAuditStatsWithOverlay`); the passive effect in `useActiveCellStore` hands it to
   `setRuntime`; the store emits for the one cell; the workspace renders again about 60 ms
   later. The whole sequence for one commit, at 4×: optimistic edit → outbox enqueue (provider
   snapshot + pending state) → **`setRuntime` from the effect** → `event.applied` for the
   commit (rows + audit map) → `event.applied` for the self-validation (audit map) → outbox
   ack → the 600 ms debounced corpus (item 4). Seven renders; this item and item 4 are the
   two that no batching removes. The fix is to compute the outbox overlay where the store
   can read it before React renders (the overlay functions in
   `src/lib/sync/audit-stats-overlay.ts` are already pure), not to move the effect.
3. **Commit and self-validation are two outbox transactions.** The notification is held across
   both today (`holdOutboxNotifications`); one transaction would remove the hold. The batch
   enqueue path journals differently — read that first.
4. **`useDebouncedValue(cellSummaries)`** renders the workspace once more 600 ms after every
   commit for the forecast and glosser corpus. Move the consumer out of the workspace render.
5. **EditorTable's `activeEditorCellId` / `focusedRailCellId`** change across blur, click and
   focus: 9 table renders per activation, and a chapter-label state that passes through `null`.
6. **The workspace commits while idle:** 5 commits, about 1,500 component renders and 1 request
   in 7.5 s with a file open and no cell active.
7. **Two cell GETs per `cell.audio.*` write** (apparently one for the POST's applied frames and
   one for the socket echo — inferred from counts, not traced), and the socket echo still asks
   for a whole-file audio read for the client's own write (the own-echo branch in
   `src/components/ProjectWorkspace.tsx`).

40. **One cell commit renders `EditorRow` 11 times** (`plain.commit.rowRenders`; a row render is
    about 98 components, so this is close to half of `plain.commit.componentRenders`). Traced
    2026-11-20 by diffing the row's props per render. The committed row renders 9 times: its
    `cell` prop changes identity five times (optimistic edit, a rebuild in which **only the
    `globalReferences` array's identity differs**, the pending validation, the applied commit,
    the applied validation); a state hook in `EditorRow` holding `{ value, valueHtml }` goes
    `null` → set → `null` within 20 ms, two renders for one transition; and its health ribbon
    point changes twice (`validated` → `automatic` → `validated`, because a commit un-validates
    the cell and the self-validation re-validates it). The next row renders twice for the
    ribbon's neighbouring opacity. Cheapest first: keep the previous view object when a
    rebuilt one is equal field by field (`getCellView` / `summaryEntry` in
    `src/hooks/useActiveCellStore.ts` cache on version only), then the set-and-clear hook.
    `TranslatedEditor` is also handed three props that are new on every row render
    (`onInitialIdmlSelectionApplied`, `terminologyConcepts`, `onFootnoteHover`).

## Editor — tree per commit

Measured after the pass: a workspace render is about 110–270 components (was about 1,000); a row
render is about 98.

8. **`ProjectWorkspace`, `EditorTable`, `EditorRow` and `TranslatedEditor` are not compiled by the
   React Compiler** (eight `exhaustive-deps` suppressions and about 27 unsupported constructs in
   the first; ref reads in render, a `??=`, one suppression in the others). Nothing in them is
   memoized unless by hand. Making even one compile is a large, permanent gain — and Vitest runs
   with the compiler off, so verify in a build with the benchmark.
9. **`AppShell` re-renders with every workspace render**: all eight slot props (`logoAccessory`,
   `leftDock`, `header`, `aboveCard`, `beforeMain`, `main`, `asideEdge`, `statusBar`) are
   elements built in the workspace's render.
10. **Per-row overlay roots.** The action rail is about 46 components (three or four buttons, each
    under a full tooltip tree, plus the overflow popover), the source context menu about 18.
    One instance per table, or mount on hover. `AppTooltip` documents that remounting its trigger
    flashes popovers, and a delegated tooltip changes the accessibility wiring — decide the
    design first.
11. **`ExportDialog` (3.6k lines), `ImportDialog` (5.2k), `AudioRecordingModal` and
    `CloneVoiceModalHost` still render while closed** — about 12 components per workspace render.
    Export's effect order picks a format while closed; Import can finish a pending import while
    closed. Audit each, then skip while closed (`src/components/memoWhileClosed.ts`).
12. **List wrappers:** every store emit runs five wrapper components for each mounted row, because
    `extraData` carries the store version by design — about 400 renders per commit.
13. **Left dock, file-options menu, header, resizable panels, side rail** re-render with every
    workspace render (inline callbacks; menu items rebuilt from `actionCtx`).

## Editor — glossary

Measured after the pass (664 terms, 12 occurring): open 6.9 s blocked against 5.5 s plain.

14. **A dense first screen compiles its terms synchronously in render.** With 200 of 664 terms
    occurring in a file: about 1.4 s at 1× for the source highlights the first time. Compile
    visible-row terms in idle slices and paint highlights when ready.
15. **Extra renders per highlighted term**: highlight spans, `HighlightedText` pieces, and an
    `AppTooltip` per rendering chip on the target side. This is the remaining 1.2–1.6× over plain.
16. **No visible "checking…" state** for the health pass that now finishes in idle slices
    (`HealthStats.infractionsPending` exists; nothing reads it).

## File open and tab return

Measured after the pass: open 39 requests (33 distinct routes), tab return 11.

17. **`audio-attachments` ×3 on open** — a default-lane read before the lane resolves (AQU-2160),
    and instances that mount after first paint. The hook deliberately has no answer cache.
18. **`sync-token` ×3 on open** for three scopes (the open file, `'any'`, the project's first
    file). The claims differ only in `fileId`; check every project-level route before sharing.
19. **33 distinct reads to open one file.** Which of them the first screen needs is a product
    question; everything else belongs after first paint.
20. **`useCellValidators`, `useCellHistory`, `useTimelineTextCells`** still flip `isLoading` on a
    focus revalidation.
21. **`useOrgSettings`**: `GET /orgs/:id/settings` ×2 on every org route, ×4 on the projects list.

41. **The first ghost-text suggestion of a session reads every other file of the project on
    the main thread** (`loadOtherFiles` in `src/hooks/useForecastCorpus.ts::useForecastCorpus`: `fetchAllFileCells`
    per file, two at a time, then a row-by-row fold before the rows are posted to the
    forecast worker). It is deliberate and happens once, but it happens while the user is
    typing their first sentence, and on a 66-book project it is 65 whole-file reads parsed
    beside the caret. The fetch and the fold belong in the worker. In the benchmark this is
    the 146 KB `GET …/files/:id/cells` counted in `commit.requests` — it is for the fixture's
    *other* file, not a read-back of the commit.

## Other surfaces

From `scripts/perf/surfaces-probe.ts` (4× throttle, 2 files / 400 cells unless noted).

22. **Voice studio open:** 2.4 s blocked, 25 commits, 10,800 renders — a tooltip root per slot
    button (`TimelineSlotButton` ×208).
23. **Timeline lens open:** 1.5–1.9 s blocked, 19–23 commits, about 6,000 renders.
24. **Rules surface:** every built-in check row (a Select and a Switch each) re-renders on each
    of the 10 renders per open (`src/components/RulesSurface.tsx`, `BuiltinChecksList.tsx`); on 20
    files the quality section is 59 commits and 46 requests and keeps committing for 7.5 s.
25. **Project overview** (`src/components/org/ProjectOverview.tsx`, 3.1k lines, not compiled): new
    `columns` and `data` for the lanes table on 7 of 7 renders; 14 commits, 18 requests to open.
26. **`src/components/ui/data-table.tsx`:** a ContextMenu root and a DropdownMenu root per row.
27. **Comment and edit-history drawers:** 24–25 commits to open one. **Export dialog open:** 27.
28. **`src/components/SearchDockPanel.tsx`:** one search request per keystroke, no debounce.
29. **`src/hooks/useOrgComments.ts`:** a sync-token and a comments read per project (48 requests
    for about 23 projects). Needs an org-level endpoint — escalate, do not fix client-side.
30. **Comments pages** render every thread card, no virtualization (unmeasured: the fixture has
    no comments).
31. **Glossary page:** 664 row mounts remain on open; `GlossaryEditor` is not compiled.
32. **Members matrix:** a Popover root and a lane-scope editor per populated cell; not virtualized.
33. Minor: `src/hooks/useFileSync.ts` polls the socket state every second;
    `ProjectSettings.tsx::withStyledTerms` builds a RegExp per call.

## Transcribe view

34. A save still renders the workspace about 5 times (about 1,600 components) — items 1–4 above.
35. `TypedText` ticks every 30 ms during a pass: most of the 407 commits left in "transcribe all".
36. The quantise loop runs on the main thread (73 ms at 4× for a 60 s window).

## The harness itself

37. **`plain.open.componentRenders` is not stable enough for its budget.** Five runs of one tree
    on one machine on 2026-11-19: 7,033, 8,604, 8,975, 9,077, 9,581 against a budget of 8,733 —
    and 9,077 was the budget commit itself. Find what makes the open's render count depend on
    timing before trusting a breach of it.
38. **The first run after seeding is not representative.** With fixtures seeded in the same
    run, `plain.commit` measured 28 row renders and 3 requests (a whole-file
    `GET …/files/:id/cells` after one cell commit); every later run of the same tree measured
    10–11 and 2. Either the benchmark should discard a warm-up commit, or a first commit on a
    new project really does re-read the file and that is a defect — not traced.
    *Partly traced 2026-11-20:* reproduced (28 row renders, 3 requests, 10 workspace renders,
    14 count budgets breached on the seeding run; 11, 2 and 7 with every budget's count met on
    the next run of the same tree). The `GET …/files/:id/cells` is in **both** runs and is
    item 41, not a re-read of the open file. What the seeding run adds is a
    `GET …/cell-confidence` and the extra renders. A nightly run that seeds its own fixtures
    always starts here, so it measures twice; a discarded warm-up commit would halve that.
39. **Commit-path render counts depend on the CPU throttle.** After one cell commit the outbox's
    separate state updates each render the workspace at 1× CPU (9 renders on 2026-11-19), but
    under the benchmark's 4× throttle some of them fall into one React batch (7). So removing
    one of those updates shows at 1× (9 → 8) and stays inside the noise at 4× (7, 7, 7 → 7, 7,
    6). Measure commit-path render counts at 1× as well before deciding a change did nothing.

42. **Two timing budgets sit inside run-to-run noise on the routine's machine.** Three runs of
    `dev` at `cc20a190` on 2026-11-20: `glossary.tabReturn.longTaskTotalMs` 200, 398, 245
    against a budget of 394, and `glossary.typing.longTaskTotalMs` 0, 117, 53 against 100.
    The middle run failed on both by 4 ms and 17 ms with every count in budget. Separately,
    `plain.tabReturn.reactCommits` is two-valued on one tree (13 or 19–20, with
    `componentRenders` 878 or about 1,450), which is wider than the 5% a fix is allowed to
    move another count metric by. Find the second mode before trusting either direction.

## Needs a person, not the routine

- **Batch drafting dies with the tab.** It is now honest and resumable, but a closed laptop stops
  it. Durability needs a server-side job (architecture decision).
- **Batch-draft spend is attributed from the URL at request time**
  (`completion-service.ts::complete`), so chunks sent while the user is on another route are
  unattributed or attributed to another project (metering decision).
- **Server write path.** `POST /events` awaits an O(file) aggregate recompute and the realtime
  broadcast before it answers (`sync-worker/src/events/`). Invisible to the local benchmark;
  a holding risk area.
- **The cause of the 22- and 17-minute gaps in the AQU-2654 session** is not established. What
  would confirm it is listed on the issue.
