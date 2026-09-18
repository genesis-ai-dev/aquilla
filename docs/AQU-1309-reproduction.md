# AQU-1309 reproduction findings

Date: 2026-09-18. Base: origin/main at de229bd497.

## Result

The client captures the pending AI draft's event ID as the parent of the
human correction. The controlled browser reproduction preserves the human
correction and its validation through acknowledgement, navigation, and reload.
It does not reproduce the reported persistent text loss.

It does reproduce a false conflict: overlapping attempts of the same AI
event ID receive one successful response and one response listing that same
ID in `stale`. This is a retry of one edit, not two competing edits.

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

The reported text overwrite is still unproven. Next: trace an incoming AI value
while a newer editor buffer has not yet entered IndexedDB.

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
- Worker route integration: 44 passed, including concurrent retry/control.
- Worker type-check: passed.
- E2E policy/impact guards: 26 passed.
- Build, including `tsc -b`, Vite, and artifact checks: passed.
- Diff whitespace check: passed.

Earlier diagnostic harness versions had an attempt-counter race and an
intercepted-request timeout waiter that stalled. Those are not product failures;
the final run completes and fails on the explicit response-contract assertion.

The isolated worktree uses existing dependency directories. Vite reports a
blocked font URL from that symlink, so these runs do not assess visual fidelity.
The final worker logs contain no slow-request warnings.

The test crosses editor/AI event producers, IndexedDB, HTTP delivery,
sync-worker arbitration, Postgres projection, and UI rehydration. The journey
map now includes these pending-draft cases. The PR fixes retry classification;
no production settings or deployment changed. The broader issue remains in
progress because persistent text loss and production queueing remain unproven.

The spec's `queue-edits-offline.md` acceptance criteria already require ordered
delivery preserving parent references. The fix restores the existing
parent-chain conflict rule: replaying an identical event is not a competing edit.
No spec change is needed. Production frontend `/version.json` reports the tested
base `de229bd` (built Sep 17). The production worker version and reported server
latency remain unverified by this local reproduction.
