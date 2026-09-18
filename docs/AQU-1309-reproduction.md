# AQU-1309 reproduction findings

Date: 2026-09-18. Base: origin/main at de229bd497.

## Result

Two separate bugs are reproduced and fixed in PR #698 (target: dev):

1. **The client forgets an unacknowledged parent after several edits.** On an
   already-translated verse H, queued edits should form H → A → B → C. A
   workspace effect sees the lagging projection H, notices H differs from B's
   immediate parent A, and incorrectly clears B from the pending-head map. C
   falls back to H and the server rejects it as a stale sibling. After the fix,
   C chains on B and survives navigation, acknowledgement, and reload.
2. **The server misclassifies overlapping retries of one event as conflicts.**
   Both requests can miss the early duplicate lookup. The transaction INSERT
   result now distinguishes the duplicate from a newly inserted competing edit.

The original two-save AI → correction test preserves the correction. The
already-translated, three-pending-edit case exposes the client bug that simpler
fixtures miss. This matches the same-author/different-ID sibling pattern found
in the Burmese project's production event history. We do not have a session
trace proving every reported AI revert followed this exact path.

## Client parent-chain reproduction

1. Save BASE-H and reload, establishing a real target head.
2. Hold subsequent event requests before they reach the server.
3. Edit/blur three times: EDIT-A, EDIT-B, EDIT-C. Inspect IndexedDB after each.
4. Before the client fix, parents are A→H, B→A, **C→H**. The server logs C
   but reports it stale; C does not become the visible projected head.
5. Remove the effect's inference that any non-parent projection means conflict.
   Retire the pending head only when that event is confirmed; explicit server
   stale handling remains in place for genuine conflicts.
6. The same browser test now passes: A→H, B→A, C→B; C persists after reload.

No clock manipulation is used in this test. Baseline artifact:
`/private/tmp/aqu-1309-existing-head-results.json`; fixed artifact:
`/private/tmp/aqu-1309-parent-fixed-results.json`.

Production cross-check: among the latest 2,000 target commits (Sep 10–17),
multiple Burmese-team events contain different text but share the same author
and parent with an earlier winning event. For example, loser
`01a0a0c8-b416-70fd-8133-6f9bfee0efba` and winner
`01a0a0c8-a535-7073-9f30-db135edfb596` share parent
`01a0a0c8-82e5-76ea-9c5c-a681b77f9588`; their client timestamps differ by
3.809 seconds. Text lengths/hashes differ (132 vs 140 characters), so this is
not an identical-event retry. The account is a Burmese posteditor. This gives
production evidence for same-author branching, not just a synthetic race.

## Reproduction

Extend `e2e/specs/collab/commit-chain-linear.smoke.spec.ts` using the real
SPA, IndexedDB outbox, local auth/sync workers, and Postgres. Only model output
and network delivery are controlled. The same test fails before the server fix
and passes afterward.

1. Generate `DRAFT-A`, holding its event request before server processing.
2. Edit to `HUMAN-B`, navigate to the next cell, and type there.
3. Read the pending outbox directly. Assert B.parentId equals A.id and the
   validation's editEventId equals B.id.
4. Release A while holding B. Assert B remains displayed.
5. Release B, verify the event chain, drain the outbox, and reload.
6. Assert B and its validation persist.
7. Assert no response classifies A's repeated event ID as a stale sibling.

Cases: human draft, AI draft, and AI draft with its first response dropped
after the server processes it. The AI interaction in these runs spans the
client timeout and queues a repeat of A. Delivery barriers can therefore
release the original attempt and its retry together.

## Before the fix

Four tests pass. Both AI cases fail only at step 7, after text and validation
survival assertions pass. The three existing chain cases and human control pass.

Example from the AI delayed-delivery case:

- A: `01a0b521-cd2b-771d-b891-4007d5184fe9`.
- First response: accepted A, no stale entries.
- Repeated request: identical A ID, parent, and value.
- Repeated response: accepted A, but also lists A in `stale`.
- B: `01a0b522-0c44-7506-8788-67b78c3343d4`, parent A.
- B response: accepted, no stale entries; B and its validation survive reload.

Synthetic-fixture evidence:

- `/private/tmp/aqu-1309-evidence.json` — compact parent and response records.
- `/private/tmp/aqu-1309-regression-results.json` — Playwright results and attachments.
- `/private/tmp/aqu-1309-regression.log` — final runner output.

## Confirmed retry mechanism and fix

`sync-worker/src/events/route.ts` prefetches existing IDs before the write
transaction (around line 882). Concurrent attempts can both miss the ID.
`flagChainLosers` then interprets a zero-row projection write as a stale
edit (around line 1580), without distinguishing an identical-event replay.

The client's stale listener clears pending heads and optimistic state for
the cell (`ProjectWorkspace.tsx`, around line 1577). This creates a plausible
connection to the reported symptom, but these runs do not demonstrate lost B.

Two real handler calls are gated after pre-checks but before their SQL batches.
The same-ID case fails before the fix; the different-ID control reports exactly
one genuine stale sibling. The fix carries the events INSERT statement index
from the cell-event handler into the route. A zero insert count identifies the
concurrent replay inside the transaction, clears any false stale classification,
and excludes the duplicate from applied frames and broadcasts. Both attempts
remain accepted. No extra database query is added.

After the fix, all six browser cases and all 44 event-route tests pass. The
same-ID regression also asserts exactly one applied frame across both attempts.
The different-ID control retains first-child/head arbitration.

The two-save buffer-only case also passes: pause the editor idle debounce, type B,
confirm B is absent from IndexedDB, release A and await its outbox drain, then
navigate, save B, and reload. Install the browser clock before application
timers. A discarded probe installed it mid-session, produced a destroyed-editor
timer exception and a visual revert; that result is a harness artifact, not
product evidence.

## Confidence path findings (read-only)

The client requests up to 100 cell scores. The route treats `cellIds` only as
an output filter: it loads up to 5,000 file cells, retrieves neighbors for up to
5,000 translated/unvalidated cells, propagates confidence, and then filters the
response. Each asker's LATERAL query ranks same-file source matches. File/lane
scoping reduces the search space; it does not bound work to the requested IDs.

`useCellConfidence` triggers immediately on file/enable, then after a 1,500ms
trailing debounce on content/validation changes. It defers changes confined to
the focused cell until focus leaves. It is not a periodic polling loop. Aborting
an obsolete browser fetch does not cancel the already-running database query.
The existing switch is browser-local (`health-confidence-overlay`), not a
per-project setting. These facts explain recurring expensive work during editing;
they do not yet prove which resource causes production save convoys.

## Production database evidence

Read-only inspection on Sep 18 at 16:18–16:25 UTC. Statistics reset Sep 7 at
16:11 UTC; these are accumulated statement times, not HTTP durations or CPU
utilization. Queries contain no translation text in the captured output.

- Confidence-neighbor SQL: 6,418 recorded calls, 3,184.9ms mean, 19,659ms max,
  20,440,657ms total (5.68 hours). About 52% of all recorded database statement
  execution time in this snapshot belongs to this one query shape. This does
  not include a per-project breakdown or establish the resource behind each
  slow save.
- Sequence allocation: 54,322 calls, 0.16ms mean, 244.13ms max. The observed
  10–15 second wait is not explained by this SQL statement's recorded duration.
- Chain claim: 14,293 calls, 0.17ms mean, 187.34ms max.
- A project-wide file-counter statement reaches 13.3s, but it has a different
  shape from the current per-file save counter. Do not attribute it to normal
  saves solely from its duration.
- At inspection time the other database connections were idle. No active lock
  convoy was captured; this does not rule out the reported busy-hour behavior.

For a Burmese project file with 1,599 source and 1,599 translated/unvalidated
target rows, plain EXPLAIN estimates one row. A bounded EXPLAIN ANALYZE for
**one asker**, in a read-only transaction with a five-second statement timeout,
shows 1,599 repeated source index probes and 8,368 shared-buffer hits (24.4ms).
The full query repeats neighbor search for all unvalidated askers, despite the
client requesting at most 100 output scores. An eight-asker control takes 210ms.
This identifies a concrete confidence-query scaling problem, not yet a causal
proof of save queueing.

A throwaway materialized-file alternative takes 404.5ms for the same eight
askers and returns the same row count. It is slower; no such SQL change is
included in the PR. No production schema, settings, or data were changed.

Evidence files (local, no credentials): `aqu-1309-db-stats.json`,
`aqu-1309-db-stats-detail.json`, `aqu-1309-confidence-plan.json`,
`aqu-1309-confidence-one-asker.json`, `aqu-1309-confidence-eight-askers.json`,
and `aqu-1309-confidence-candidate.json`, all under `/private/tmp`.

## Validation and scope

Commands run:

```sh
E2E_VITE_MODE=dev npx tsx scripts/e2e-up.ts -- \
  e2e/specs/collab/commit-chain-linear.smoke.spec.ts \
  --reporter=line,json
pnpm test:e2e:guard
npm run build
git diff --check
```

- Baseline browser run: 4 passed, 2 failed on the new false-conflict assertion.
- Fixed browser run: 6 passed (`/private/tmp/aqu-1309-fixed-results.json`).
- Additional buffer-only case: passed (`/private/tmp/aqu-1309-buffer-confirm-results.json`).
- Initial affected-browser gates: 7 passed, then 8 passed after adding the buffer-only case.
- Existing-head regression: failed before the client fix; passed after it (14.0s).
- Secret scan: clean.
- Worker route integration: 44 passed, including concurrent retry/control.
- Worker type-check: passed.
- E2E policy/impact guards: 26 passed.
- Build, including `tsc -b`, Vite, and artifact checks: passed.
- Diff whitespace check: passed.

Earlier diagnostic harness versions had an attempt-counter race and an
intercepted-request timeout waiter that stalled. Those are not product failures;
the baseline run completes and fails on the explicit response-contract assertion.
The fixed run passes that assertion.

The isolated worktree uses existing dependency directories. Vite reports a
blocked font URL from that symlink, so these runs do not assess visual fidelity.
The final worker logs contain no slow-request warnings.

The test crosses editor/AI event producers, IndexedDB, HTTP delivery,
sync-worker arbitration, Postgres projection, and UI rehydration. The journey
map now includes these pending-draft cases. The PR fixes parent retention and
retry classification. No production settings or deployment changed. The broader
issue remains in progress: production queueing, project confidence controls, and
telemetry are not resolved by these correctness fixes.

The spec's `queue-edits-offline.md` acceptance criteria already require ordered
delivery preserving parent references. The fix restores the existing
parent-chain conflict rule: local descendants retain their pending ancestry,
and replaying an identical event is not a competing edit.
No spec change is needed. Production frontend `/version.json` reports the tested
base `de229bd` (built Sep 17). The production worker version and reported server
latency remain unverified by this local reproduction.
