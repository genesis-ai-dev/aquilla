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
   renders to 8. *Step 2 done (2026-11-19):* the eight hooks that re-read on a notification
   (`useActiveCellStore`, `useOutboxSnapshot`, `usePendingOutboxRecords`,
   `useForbiddenOutboxRecords`, `useRefusedFileEvents`, `useRefusedComments`, `useCells`,
   `useProjectCells` up to 2,000 rows) share one in-flight scan (`peekOutboxShared` in
   `src/lib/sync/outbox.ts`), so they resume in one task and React renders them together:
   7 → 5 workspace renders per commit at 1× (after item 4 landed); at 4× the count varies
   from run to run (7, 7, 6, 5 → 6, 5, 6, 5). *Left:* each hook still keeps its own
   subscription and its own state; the workspace still subscribes to the whole outbox context.
   The two `store#` version bumps that remain on this path are item 2.
2. **Audit stats are workspace state pushed into the store by an effect** (`store.setRuntime`),
   and `useSyncExternalStore`'s consistency check forces a second render. Apply them in the same
   task as their cause, or keep them out of workspace state.
   *Traced 2026-11-21 (nightly, `plain.commit`, 4× throttle; probe hooked to
   `window.__cellStore.emitAll` and diffing `ProjectWorkspace`'s hook state per React commit).*
   One cell commit makes 6 workspace renders, in this order: (1) `applyOptimisticTargetEdit`;
   (2) the outbox enqueue, which reaches the workspace through `OutboxProvider` and, in the same
   render, through the store's own `setPendingState` refresh; (3) **`setRuntime` from the
   passive effect in `useActiveCellStore`, because render 2 recomputed the audit overlay in
   `useCellsAuditStatsWithOverlay`. This is the render this item removes: about 220 of the
   commit's 2,100 component renders**; (4) the socket echo (`liveApplier` batch) plus
   `applyCommittedCellStats`; (5) `applyValidationCellStats`, alone in its own task once
   `onOwnEcho`'s outbox lookup resolves (`src/lib/sync/flush-applied.ts`), which is a second
   avoidable render of about 100 components; (6) the outbox draining. The store and the audit
   overlay read the same outbox notification through two separate pipelines (the store's
   pending refresh, and React state through `OutboxProvider`). That is why their updates land
   in separate tasks and `WHOLE_FILE_NOTIFY_MS` cannot merge them. The fix is one pipeline: the
   store computes the audit overlay from the pending records it already reads. That interacts
   with item 1's remaining step, so design the two together.
3. **Commit and self-validation are two outbox transactions.** The notification is held across
   both today (`holdOutboxNotifications`); one transaction would remove the hold. The batch
   enqueue path journals differently — read that first.
4. ~~**`useDebouncedValue(cellSummaries)`** renders the workspace once more 600 ms after every
   commit for the forecast and glosser corpus. Move the consumer out of the workspace render.~~
   *Done (2026-11-19):* the corpus is a `useDebouncedSource` — read on demand, with a signal
   that an open Back-translation tab follows. The other `useDebouncedValue` callers are small
   components and were left alone.
5. **EditorTable's `activeEditorCellId` / `focusedRailCellId`** change across blur, click and
   focus: 9 table renders per activation, and a chapter-label state that passes through `null`.
7. **The socket echo of the client's own `cell.audio.*` write asks for a whole-file audio read**
   (the own-echo branch in `src/components/ProjectWorkspace.tsx`): one `audio-attachments` GET
   per transcribe save. It is not a pure duplicate today: `saveTranscript`
   (`src/lib/transcript-cleanup/save.ts`) only injects an optimistic overlay and relies on that
   read to reconcile it, while other writers notify themselves. Dropping it needs every audio
   writer (about 14 call sites) to land or reconcile its own write first. *(2026-11-20: the two
   cell GETs per write are fixed — row-less frames are refetched once per event,
   `src/lib/sync/refetch-once-per-event.ts`.)*

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
   elements built in the workspace's render. *Traced 2026-11-20* (`surfaces-probe --why
   AppShell`): all eight change identity on every workspace render (39 of 40 renders on a file
   open), and so do `LeftDock`'s four panels and `WorkspaceHeader`'s `onImport`. AppShell's own
   share is small — it is compiled, so its chrome (version tag, help, history) is cached; what
   re-renders is AppShell, its `ErrorBoundary` and the resizable panels. The cause is item 8:
   the workspace is not compiled, so nothing it builds is cached. Fix item 8, not AppShell.
10. **Per-row overlay roots.** The action rail is about 46 components (three or four buttons, each
    under a full tooltip tree, plus the overflow popover), the source context menu about 18.
    One instance per table, or mount on hover. `AppTooltip` documents that remounting its trigger
    flashes popovers, and a delegated tooltip changes the accessibility wiring — decide the
    design first.
12. **List wrappers:** every store emit runs five wrapper components for each mounted row, because
    `extraData` carries the store version by design — about 400 renders per commit.
13. **Left dock, file-options menu, header, resizable panels, side rail** re-render with every
    workspace render (inline callbacks; menu items rebuilt from `actionCtx`). *Traced
    2026-11-20*: `FileChapterToolbar` gets new `historyControl`, `layoutSwitch`,
    `onCheckToggle`, `menuItems` and `viewSettingsMenu` each render; `ResizablePanelGroup` new
    `children` and `onLayoutChanged`. Same cause as item 9: hand-memoizing each of these would
    duplicate, with long hand-kept dependency lists, what compiling the workspace (item 8) does.

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
    and instances that mount after first paint. The hook deliberately has no answer cache. A mount
    now joins the read already in flight (AQU-2655); what is left needs `ProjectWorkspace.tsx`:
    the `''`-lane read comes from `useActiveLane` starting at `''` before the lane rows arrive (the
    callers at PW `audioValidation…` and `EditorTable` read it; they need a "lane resolved" gate),
    and on the Text lens neither the PW:2375 instance nor EditorTable's needs the map before
    first paint.
18. **`sync-token` ×3 on open** for three scopes (the open file, `'any'`, the project's first
    file). The claims differ only in `fileId`; check every project-level route before sharing.
    Checked (AQU-2655, read-only): the mint's role, scopes and lane grants do not depend on
    `fileId`, and the sync-worker has no `'any'` wildcard — `verifyTokenForProject` ignores
    `fileId`, `verifyTokenForFile`/`verifyTokenForDoc` require an exact match. So the
    first-file mint is only ever used for project-level reads (`/files` via
    `useOriginalSourceFlags` and `refreshAllFilesProgress`, `useProjectPlan`), and minting
    `'any'` there instead joins the existing `'any'` mint and *narrows* what those requests
    carry. That change is in `ProjectWorkspace.tsx` (`progressSnapshotTokenFileId`, and the
    fetcher passed to `useOriginalSourceFlags`). Do not go further and send the open file's
    token to project-level routes to reach ×1: that puts file-scoped authority on requests
    that do not need it — a person's call, not the routine's.
19. **33 distinct reads to open one file.** Which of them the first screen needs is a product
    question; everything else belongs after first paint.
20. **`useCellValidators`, `useCellHistory`** still flip `isLoading` on a focus revalidation, but
    nothing mounts either hook (only their own tests import them), so no screen pays for it.
    Delete them, or fix them when a caller comes back. (`useTimelineTextCells`: fixed, AQU-2655.)

## Other surfaces

From `scripts/perf/surfaces-probe.ts` (4× throttle, 2 files / 400 cells unless noted).

23. **Timeline lens and voice studio open** (re-measured 2026-11-20 after the slot buttons
    share one tooltip root per lane): lens 18 commits, 4,268 renders; voice studio 27 commits,
    8,558 renders. What is left is the same pattern as item 10, on the timeline: an overlay root
    per chip and per track — a `ContextMenu` per take and per track row
    (`TargetAudioLane.tsx`, `TimelineEditor.tsx`'s track rows), `AppTooltip`s on each take's
    toolbar, a `DropdownMenu` root per narrow line's slot menu (`TimelineSlotButton` `menu`,
    49 on open), and 77 `Popover` roots not yet attributed (not in `src/components/timeline/`).
    The lanes are inline elements of the 6k-line `TimelineEditor` with inline callbacks, so every
    editor render re-renders every lane. The CPU profile of the lens open is led by
    `getBoundingClientRect` (88 ms self time at 4×, caller not traced) and
    `scrollIntoViewIfNeeded` (19 ms) — forced layout, not rendering.
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

## The harness itself

38. **A first translation of an empty cell is not measured, and may cost more than it should.**
    The scenario edits the same cells every run. On a newly seeded fixture they are
    untranslated, and `plain.commit` measured 28 row renders, 10 workspace renders and one or
    two extra reads (`cell-confidence`, `branching-search`; one run also saw a whole-file
    `GET …/files/:id/cells`); on a fixture that has been run against, the same tree measures
    10–11, 7–8 and none. The harness now runs one unmeasured settling pass after it seeds
    (2026-11-20), so the budgets describe an edit and a new machine no longer sees a false
    breach. What is left: whether 28 row renders for a first translation is the price of the
    cell changing state or a defect — not traced. Trace it, then give it its own phase.

40. **`plain.commit.requests` counts a one-time corpus load.** One of the commit phase's two
    requests is `GET …/files/<the other file>/cells?limit=500&lane=…`: the forecast corpus
    loading every other file the first time the editor asks for a suggestion
    (`loadOtherFiles` in `src/hooks/useForecastCorpus.ts`, by design). The typing phase ends before
    the load starts, so the load lands in the commit window. A commit itself costs one request
    (the `POST /events`). Either load the corpus in a phase of its own, or exclude it from the
    commit's count, before the commit request budget is next lowered (traced 2026-11-21).
41. **Container commits after every whole-file store wake-up.** About 40 ms after each
    workspace render that a store emit started, a separate React commit renders two
    `ComboboxTrigger`s and every mounted Legend List `Container` (237, 49 and 227 components in
    one commit, about a quarter of the commit's renders). Item 12 is the per-row part. Which two
    comboboxes subscribe on their own is not traced yet (2026-11-21).

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
