# Optimistic Bulk Translation Import via Outbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bulk translation (target) import feel instant by enqueuing commits to the existing CQRS outbox and showing imported content optimistically, instead of blocking the UI on a chunked HTTP POST loop followed by a full refetch.

**Architecture:** Route all bulk **target** commits (`target.cell.commit`) through the same IndexedDB outbox the editor already uses, instead of `bulkUploadTargetCommits`' direct POST loop. The existing pending-outbox overlay in `useCells` renders queued commits immediately as `hasPendingEdit`; the existing `OutboxSyncIndicator` + `OutboxInspectorPopover` provide pending count, retry, and dead-letter for free. A bulk optimistic-shadow write prevents flicker on the active file; a loop-until-drained flusher change (which also fixes the separately-diagnosed batch-validation lag) keeps the backlog from crawling; a debounced overlay refresh prevents a rebuild storm during the drain.

**Tech Stack:** React + TypeScript SPA, IndexedDB outbox (`src/lib/sync/`), Vitest (happy-dom), Playwright e2e (`verify-dev-change` skill / dev stack).

**Scope:** Bulk **target** writes only — every caller of `bulkUploadTargetCommits`: `applyEBibleTargetImport` (used by FileTargetImportPanel, PairedImportPanel, ImportDialog target step) and `importParatextAsTarget`. **Out of scope:** source imports (`bulkUploadSource`), morphology (`bulkUploadMorphRows`), and moving file parsing off the main thread (separate follow-up).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/lib/sync/outbox.ts` | IDB outbox primitives | **Add** `enqueueOutboxEvents()` — N records, one txn, one notify |
| `src/lib/sync/events-emit.ts` | Typed event builders → outbox | **Add** `enqueueEvents()` — build + bulk-enqueue N inputs |
| `src/lib/sync/bulk-import.ts` | Bulk uploaders | **Replace** `bulkUploadTargetCommits` POST loop with `enqueueTargetCommits` (outbox enqueue) |
| `src/lib/import.ts` | Import orchestration | Point `applyEBibleTargetImport` + `importParatextAsTarget` at `enqueueTargetCommits`; return fast |
| `src/hooks/useCells.ts` | Read model + overlays | **Add** `applyOptimisticTargetEdits()` (bulk shadow, one rebuild); **debounce** the pending-overlay refresh |
| `src/hooks/useOutboxFlusher.ts` | Background drain loop | **Loop-until-drained** per cycle; expose `flushNow` (exists) for immediate kick |
| `src/components/import/FileTargetImportPanel.tsx` | File-target import UI | Optimistic patch active file, enqueue, close immediately, drop blocking step + refetch |
| `src/components/import/PairedImportPanel.tsx` | Paired import UI | Same UX change |
| `src/components/ImportDialog.tsx` | eBible/Paratext target step | Same UX change |
| `src/components/ProjectWorkspace.tsx` | Workspace wiring | One soft `revalidateCells()` when active-file pending drains; remove the synchronous post-import full refetch |

---

## Background facts the implementer needs (verified against current code)

- `useCells` already overlays pending `target.cell.commit`/`target.cell.create` outbox records onto the **active file's** cells on every outbox change, rendering them as `hasPendingEdit` ([useCells.ts:815-859](../../../src/hooks/useCells.ts)). Enqueuing to the outbox therefore shows imported content with **no new optimistic-display code** — but the overlay reads `peekOutboxBatch(2000)` and rebuilds on *every* outbox mutation (the storm risk, Task 6).
- When a record flips to `failed` (status set by `markOutboxAttempt` at `OUTBOX_MAX_ATTEMPTS = 5`), the overlay excludes it and clears its optimistic shadow ([useCells.ts:834-848](../../../src/hooks/useCells.ts)); the inspector still shows it with a retry affordance. This is the "keep content + retry banner" behavior — native, no new UI.
- `enqueueOutboxEvent(event)` writes one record in one txn + one `notifyOutboxChanged()` ([outbox.ts:132-150](../../../src/lib/sync/outbox.ts)). N single calls = N txns + N notifies = N overlay rebuilds. Bulk needs one txn + one notify (Task 1).
- The events `bulkUploadTargetCommits` builds are already outbox-shaped: `kind: "target.cell.commit"`, deterministic `uuidv7()` id (idempotent retry), `parentId` from the chain ([bulk-import.ts:266-277](../../../src/lib/sync/bulk-import.ts), [import.ts:255-262](../../../src/lib/import.ts)).
- The flusher runs `flushOutboxBatch` once per 5s tick; each flush sends ≤100 records for a single file ([useOutboxFlusher.ts:108-137](../../../src/hooks/useOutboxFlusher.ts), [outbox-flush.ts:20,124](../../../src/lib/sync/outbox-flush.ts)). `flushNow()` resets backoff and forces a tick. `flushOutboxBatch` returns `{ posted, accepted, networkError, authError, quarantined, staleSiblingCount, staleSourceCount }`.

---

## Task 1: Bulk outbox enqueue primitive

**Files:**
- Modify: `src/lib/sync/outbox.ts` (after `enqueueOutboxEvent`, line 150)
- Test: `src/lib/sync/outbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sync/outbox.test.ts
import { enqueueOutboxEvents, peekOutboxBatch } from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"

function ev(id: string, cellId: string): CqrsRawEvent {
  return {
    id, schemaVersion: 1, kind: "target.cell.commit",
    projectId: "p1", fileId: "f1", cellId, parentId: "src1",
    author: "u1", payload: { value: `v-${cellId}` }, clientTs: 1,
  } as unknown as CqrsRawEvent
}

it("enqueueOutboxEvents writes all events and fires exactly one change notification", async () => {
  let notifications = 0
  const { subscribeToOutbox } = await import("./outbox")
  const unsub = subscribeToOutbox(() => { notifications++ })
  await enqueueOutboxEvents([ev("e1", "c1"), ev("e2", "c2"), ev("e3", "c3")])
  unsub()
  const rows = await peekOutboxBatch(100)
  expect(rows.map((r) => r.id).sort()).toEqual(["e1", "e2", "e3"])
  expect(notifications).toBe(1) // one notify for the whole batch, not three
})

it("enqueueOutboxEvents is idempotent on duplicate ids (same-id put overwrites)", async () => {
  await enqueueOutboxEvents([ev("dup", "c1")])
  await enqueueOutboxEvents([ev("dup", "c1")])
  const rows = await peekOutboxBatch(100)
  expect(rows.filter((r) => r.id === "dup")).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/sync/outbox.test.ts -t "enqueueOutboxEvents"`
Expected: FAIL — `enqueueOutboxEvents is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/sync/outbox.ts — add after enqueueOutboxEvent (line 150)
/** Enqueue many events in ONE transaction and fire a SINGLE change
 *  notification. Used by bulk import so a large batch produces one overlay
 *  rebuild + one badge refresh instead of N. Same-id `put` overwrites, so a
 *  re-enqueue of already-queued events is a no-op (idempotent). */
export async function enqueueOutboxEvents(events: CqrsRawEvent[]): Promise<void> {
  if (events.length === 0) return
  const db = await openDb()
  const now = Date.now()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("bulk enqueue tx failed"))
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const event of events) {
      store.put({
        id: event.id, enqueuedAt: now, event,
        attempts: 0, lastAttemptAt: null, lastError: null, status: "pending",
      } satisfies OutboxRecord)
    }
  })
  notifyOutboxChanged()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/sync/outbox.test.ts -t "enqueueOutboxEvents"`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/outbox.ts src/lib/sync/outbox.test.ts
git commit -m "feat(sync): enqueueOutboxEvents — bulk enqueue in one txn, one notify"
```

---

## Task 2: Typed bulk builder `enqueueEvents`

**Files:**
- Modify: `src/lib/sync/events-emit.ts` (after `enqueueEvent`, line 140)
- Test: `src/lib/sync/events-emit.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sync/events-emit.test.ts
import { enqueueEvents } from "./events-emit"
import { peekOutboxBatch } from "./outbox"

it("enqueueEvents builds typed events and bulk-enqueues them", async () => {
  const res = await enqueueEvents([
    { kind: "target.cell.commit", projectId: "p", fileId: "f", cellId: "c1",
      parentId: "s1", author: "u", payload: { value: "hello" } },
    { kind: "target.cell.commit", projectId: "p", fileId: "f", cellId: "c2",
      parentId: "s2", author: "u", payload: { value: "world" } },
  ])
  expect(res).toHaveLength(2)
  expect(res[0].eventId).toBeTruthy()
  const rows = await peekOutboxBatch(100)
  expect(rows.map((r) => r.event.cellId).sort()).toEqual(["c1", "c2"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/sync/events-emit.test.ts`
Expected: FAIL — `enqueueEvents is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/sync/events-emit.ts — add after enqueueEvent (line 140)
/** Build + bulk-enqueue many typed events in one outbox transaction.
 *  Mirrors enqueueEvent's role gate per input, then writes the whole batch at
 *  once via enqueueOutboxEvents (one notify → one overlay rebuild). */
export async function enqueueEvents<K extends OutboxEventKind>(
  inputs: BuildEventInput<K>[],
): Promise<{ event: OutboxRawEvent<K>; eventId: string }[]> {
  if (inputs.length === 0) return []
  const roleLevel = getCqrsOutboxBridge()?.roleLevel ?? null
  const events = inputs.map((input) => {
    if (!canPerform(input.kind, roleLevel) && roleLevel != null) {
      throw new InsufficientRoleError(input.kind, roleLevel, requiredRoleFor(input.kind) ?? 0)
    }
    return buildRawEvent(input)
  })
  await enqueueOutboxEvents(
    events as unknown as Parameters<typeof enqueueOutboxEvents>[0],
  )
  return events.map((event) => ({ event, eventId: event.id }))
}
```

Add the import at the top of the file: `enqueueOutboxEvents` alongside the existing `enqueueOutboxEvent` import (line 18 area).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/sync/events-emit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/events-emit.ts src/lib/sync/events-emit.test.ts
git commit -m "feat(sync): enqueueEvents — typed bulk builder over enqueueOutboxEvents"
```

---

## Task 3: Replace target upload with outbox enqueue

**Files:**
- Modify: `src/lib/sync/bulk-import.ts:252-300` (`bulkUploadTargetCommits` → `enqueueTargetCommits`)
- Modify: `src/lib/import.ts:264` (`applyEBibleTargetImport`) and `src/lib/import.ts:1300` (`importParatextAsTarget`)
- Test: `src/lib/sync/bulk-import.test.ts`, `src/lib/import.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sync/bulk-import.test.ts
import { enqueueTargetCommits } from "./bulk-import"
import { peekOutboxBatch } from "./outbox"

it("enqueueTargetCommits enqueues target.cell.commit events to the outbox (no network)", async () => {
  let fetchCalls = 0
  await enqueueTargetCommits({
    projectId: "p", fileId: "f", author: "u",
    commits: [
      { id: "e1", cellId: "c1", parentId: "s1", value: "hola" },
      { id: "e2", cellId: "c2", parentId: "s2", value: "mundo" },
    ],
    fetchImpl: (async () => { fetchCalls++; return new Response("{}") }) as typeof fetch,
  })
  expect(fetchCalls).toBe(0) // enqueue is local — the flusher does the network
  const rows = await peekOutboxBatch(100)
  const mine = rows.filter((r) => ["e1", "e2"].includes(r.id))
  expect(mine).toHaveLength(2)
  expect(mine[0].event.kind).toBe("target.cell.commit")
  expect((mine.find((r) => r.id === "e1")!.event.payload as { value: string }).value).toBe("hola")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/sync/bulk-import.test.ts -t "enqueueTargetCommits"`
Expected: FAIL — `enqueueTargetCommits is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/sync/bulk-import.ts — replace bulkUploadTargetCommits (lines 252-300)
/** Enqueue target commits to the outbox instead of POSTing them directly.
 *  The background flusher drains them (idempotent by deterministic id), the
 *  pending-overlay shows them immediately, and the sync badge/inspector
 *  surface progress + retry. Local + instant; no per-chunk network here. */
export async function enqueueTargetCommits(args: BulkTargetCommitArgs): Promise<void> {
  if (args.commits.length === 0) return
  const events = args.commits.map((c) => ({
    id: c.id,
    schemaVersion: 1 as const,
    kind: "target.cell.commit" as const,
    projectId: args.projectId,
    fileId: args.fileId,
    cellId: c.cellId,
    parentId: c.parentId,
    author: args.author,
    payload: { value: c.value, sourceEventId: c.parentId },
    clientTs: Date.now(),
  }))
  await enqueueOutboxEvents(events as unknown as Parameters<typeof enqueueOutboxEvents>[0])
  args.onProgress?.(args.commits.length, args.commits.length)
}
```

Add `import { enqueueOutboxEvents } from "./outbox"` to the top of `bulk-import.ts`. The `fetchImpl` field stays on `BulkTargetCommitArgs` for test-signature compatibility but is unused (note this in a comment). Then update the two callers:

```ts
// src/lib/import.ts:264 — inside applyEBibleTargetImport
await enqueueTargetCommits({
  projectId: ctx.projectId, fileId, author: ctx.author, commits,
  getToken: ctx.getToken, signal: ctx.signal,
  onProgress: (count) => {
    totalEnqueued += count
    onProgress?.({ phase: "save", cellsEnqueued: totalEnqueued, cellsTotal: toCommit.length })
  },
})
```

```ts
// src/lib/import.ts:1300 — inside importParatextAsTarget, replace bulkUploadTargetCommits(...) with enqueueTargetCommits(...) (identical args object)
```

Keep `getToken`/`signal` in the args type even though enqueue ignores them (DRY: callers pass them; removing them is a wider diff for no gain — leave a one-line comment).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/sync/bulk-import.test.ts src/lib/import.test.ts`
Expected: PASS. Existing `bulk-import` tests that asserted on POST calls for the target path must be updated to assert on outbox enqueue — update them in this step (do not delete coverage; re-point it).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/bulk-import.ts src/lib/import.ts src/lib/sync/bulk-import.test.ts src/lib/import.test.ts
git commit -m "feat(import): route bulk target commits through the outbox (FRO-import-optimistic)"
```

---

## Task 4: Bulk optimistic shadow in useCells (no-flicker active file)

**Why:** When the flusher drains a record, the overlay drops it and the cell would briefly revert to the pre-import server row until a refetch lands. The optimistic-shadow map (`optimisticEditsRef`) survives overlay removal and is cleared only by a confirming fetch — so writing shadows for the active file's imported cells prevents flicker. Bulk variant rebuilds once (avoids the per-cell O(N²) rebuild trap).

**Files:**
- Modify: `src/hooks/useCells.ts` (after `applyOptimisticTargetEdit`, line 1062; export from the hook return at line 1064)
- Test: `src/hooks/useCells.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/useCells.test.tsx — within the existing render harness
it("applyOptimisticTargetEdits patches many cells and rebuilds once", async () => {
  const { result } = renderUseCells({ /* existing fixture with cells c1,c2,c3 */ })
  const rebuildSpy = spyOnRebuild(result) // existing test util, or count setCells calls
  act(() => {
    result.current.applyOptimisticTargetEdits([
      { cellId: "c1", value: "a" },
      { cellId: "c2", value: "b" },
    ])
  })
  expect(result.current.cells.find((c) => c.id === "c1")!.translated).toBe("a")
  expect(result.current.cells.find((c) => c.id === "c2")!.translated).toBe("b")
  expect(result.current.cells.find((c) => c.id === "c1")!.hasPendingEdit).toBe(true)
  expect(rebuildSpy.calls).toBe(1) // ONE rebuild for the whole batch
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/hooks/useCells.test.tsx -t "applyOptimisticTargetEdits"`
Expected: FAIL — `applyOptimisticTargetEdits is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/hooks/useCells.ts — add after applyOptimisticTargetEdit (line 1062)
/** Bulk optimistic patch for imported translations. Stamps shadows for every
 *  cellId (so flush-before-refetch can't flicker them back), mutates rowsRef in
 *  place, and rebuilds ONCE. Shadows are cleared by clearConfirmedShadows when
 *  a server fetch confirms the value (see revalidateCells reconciliation). */
const applyOptimisticTargetEdits = useCallback(
  (patches: { cellId: string; value: string; valueHtml?: string }[]) => {
    if (patches.length === 0) return
    const rows = rowsRef.current
    for (const patch of patches) {
      const seq = ++writeSeqRef.current
      optimisticEditsRef.current.set(patch.cellId, { value: patch.value, valueHtml: patch.valueHtml, seq })
      cellFreshnessRef.current.set(patch.cellId, seq)
      let touched = false
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (r.cellId !== patch.cellId || r.side !== "target") continue
        rows[i] = { ...r, value: patch.value, valueHtml: patch.valueHtml ?? null }
        touched = true
        break
      }
      if (!touched) {
        const src = rows.find((r) => r.cellId === patch.cellId && r.side === "source")
        if (!src) continue
        rows.push({
          ...src, side: "target", value: patch.value, valueHtml: patch.valueHtml ?? null,
          eventId: "", sourceEventId: src.eventId, lastEditor: usernameRef.current,
          lastEditAt: Date.now(), validated: false,
          wordCount: patch.value.trim() ? patch.value.trim().split(/\s+/).length : 0,
        })
      }
    }
    rebuildFromCache()
  },
  [rebuildFromCache],
)
```

Add `applyOptimisticTargetEdits` to the hook's return object (line 1064).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/hooks/useCells.test.tsx -t "applyOptimisticTargetEdits"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCells.ts src/hooks/useCells.test.tsx
git commit -m "feat(cells): applyOptimisticTargetEdits — bulk optimistic patch, single rebuild"
```

---

## Task 5: Loop-until-drained flusher (also fixes batch-validation lag)

**Why:** Each tick flushes one ≤100 batch then waits 5s. A bulk import (or batch-validate) of >100 events drains at ~100/5s. Loop within a cycle while progress is being made so the backlog clears promptly. Bounded by a max-iterations guard so a persistently-failing queue still backs off.

**Files:**
- Modify: `src/hooks/useOutboxFlusher.ts:108-137` (`runFlushCycle`)
- Test: `src/lib/sync/outbox-flush.test.ts` (drive `flushOutboxBatch` repeatedly) + `src/hooks/useOutboxFlusher.test.tsx` if present

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/useOutboxFlusher.test.tsx (or a focused unit test on the cycle helper)
it("drains a >100 backlog in one cycle instead of one batch per interval", async () => {
  await seedOutbox(250) // 250 pending records, single file
  const flushed = await runFlushCycleForTest({ maxIterations: 50 })
  expect(flushed.totalAccepted).toBe(250)   // all drained in the cycle
  expect(flushed.iterations).toBeGreaterThan(1)
})

it("stops looping when a cycle makes no progress (no busy-spin)", async () => {
  await seedOutbox(10)
  const flushed = await runFlushCycleForTest({ failAll: true, maxIterations: 50 })
  expect(flushed.iterations).toBe(1) // first batch failed → break, let backoff handle it
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/hooks/useOutboxFlusher.test.tsx`
Expected: FAIL — current cycle flushes one batch only.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/hooks/useOutboxFlusher.ts — replace the body of runFlushCycle (lines 108-137)
const MAX_DRAIN_ITERATIONS = 200 // backstop: 200 × ≤100 = up to 20k events/cycle
const runFlushCycle = async () => {
  let madeProgress = false
  let iterations = 0
  let sawAuthError = false
  for (; iterations < MAX_DRAIN_ITERATIONS; iterations++) {
    const result = await flushOutboxBatch({
      getTokenForFile: (pid, fid) => tokenRef.current(pid, fid),
      onStaleSiblings: (entries) => {
        if (entries.length === 0) return
        setStaleSiblingCount((n) => n + entries.length)
        setStaleSiblingEntries(entries)
      },
      onStaleSource: (entries) => setStaleSourceCount((n) => n + entries.length),
    })
    if (result.authError) { sawAuthError = true; break }
    // No work, or this batch made no forward progress → stop looping.
    if (result.posted === 0) break
    if (result.accepted === 0) break
    madeProgress = true
  }
  await refreshPending()
  const failedHard = !madeProgress && iterations > 0
  if (failedHard || sawAuthError) {
    setFailureStreak((s) => s + 1)
    backoffExp.current = Math.min(8, backoffExp.current + 1)
  } else {
    setFailureStreak(0)
    backoffExp.current = 0
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/hooks/useOutboxFlusher.test.tsx src/lib/sync/outbox-flush.test.ts`
Expected: PASS. Confirm existing flusher tests (backoff, in-flight guard, Web Lock path) still pass — the loop is inside `runFlushCycle`, the reentrancy/lock wrappers are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOutboxFlusher.ts src/hooks/useOutboxFlusher.test.tsx
git commit -m "perf(sync): loop-until-drained per flush cycle (fixes bulk drain + batch-validate lag)"
```

---

## Task 6: Debounce the pending-overlay refresh (kill the rebuild storm)

**Why:** `useCells`' overlay effect subscribes to outbox changes and, on every change, reads `peekOutboxBatch(2000)` and rebuilds. During a multi-hundred/thousand-cell drain, removals fire the subscription per batch → repeated 2000-row reads + rebuilds. Coalesce bursts into one refresh.

**Files:**
- Modify: `src/hooks/useCells.ts:815-859` (the pending-overlay effect)
- Test: `src/hooks/useCells.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/useCells.test.tsx
it("coalesces a burst of outbox notifications into a single overlay refresh", async () => {
  const { result, peekSpy } = renderUseCells({ /* active file f1 */ })
  peekSpy.reset()
  act(() => { for (let i = 0; i < 20; i++) notifyOutboxChangedForTest() })
  await flushMicrotasksAndTimers()
  expect(peekSpy.calls).toBe(1) // 20 notifications → 1 peekOutboxBatch
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/hooks/useCells.test.tsx -t "coalesces"`
Expected: FAIL — currently one `peekOutboxBatch` per notification.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/hooks/useCells.ts — inside the pending-overlay effect (around line 815)
// Replace the direct `subscribeToOutbox(refresh)` with a debounced wrapper.
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const scheduleRefresh = () => {
  if (refreshTimer !== null) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 50) // coalesce a drain burst into one read+rebuild
}
void refresh() // immediate first paint
const unsub = subscribeToOutbox(scheduleRefresh)
return () => {
  cancelled = true
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  unsub()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/hooks/useCells.test.tsx -t "coalesces"`
Expected: PASS. Also re-run the full `useCells` suite — the 50ms debounce must not break existing "edit shows immediately" tests (they should advance timers).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCells.ts src/hooks/useCells.test.tsx
git commit -m "perf(cells): debounce pending-overlay refresh to coalesce drain bursts"
```

---

## Task 7: Caller UX — instant + background for the three target-import panels

**Files:**
- Modify: `src/components/import/FileTargetImportPanel.tsx:130-145` (`handleApply`)
- Modify: `src/components/import/PairedImportPanel.tsx:109-118`
- Modify: `src/components/ImportDialog.tsx` target step (~1473-1510)
- Modify: `src/components/ProjectWorkspace.tsx:3718` (`onImported`) — pass an optimistic-patch + drop the synchronous full refetch
- Test: component tests for FileTargetImportPanel + PairedImportPanel

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/import/FileTargetImportPanel.test.tsx
it("on apply: patches cells optimistically, enqueues, and closes immediately (no blocking spinner)", async () => {
  const onImported = vi.fn()
  const applyOptimisticTargetEdits = vi.fn()
  renderPanel({ onImported, applyOptimisticTargetEdits, matchResult: twoMatches })
  await userEvent.click(screen.getByRole("button", { name: /import 2/i }))
  // Optimistic patch fired with both cells BEFORE any network/flush:
  expect(applyOptimisticTargetEdits).toHaveBeenCalledWith([
    expect.objectContaining({ cellId: "c1" }),
    expect.objectContaining({ cellId: "c2" }),
  ])
  // Dialog reports done immediately (no awaiting a POST loop):
  await waitFor(() => expect(onImported).toHaveBeenCalledWith(2))
  expect(screen.queryByText(/importing/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/import/FileTargetImportPanel.test.tsx`
Expected: FAIL — panel doesn't accept/call `applyOptimisticTargetEdits` and still shows the importing step.

- [ ] **Step 3: Write minimal implementation**

```tsx
// FileTargetImportPanel.tsx — handleApply (replace lines 130-145)
async function handleApply() {
  if (!matchResult) return
  setError(null)
  const selected = matchResult.matched.filter((m) => selectedCellIds.has(m.cellId))
  // 1) Optimistic: show imported translations in the active file right now.
  applyOptimisticTargetEdits(
    selected.map((m) => ({ cellId: m.cellId, value: m.incomingText })),
  )
  try {
    // 2) Enqueue to the outbox (fast, local). The flusher drains in the
    //    background; the sync badge shows pending; the inspector shows retries.
    const { committedCount } = await applyEBibleTargetImport(
      matchResult, selectedCellIds, { projectId, author: username, getToken },
    )
    // 3) Close immediately — content is already visible + queued.
    onImported(committedCount)
  } catch (err) {
    setError(err instanceof Error ? err.message : "Import failed")
  }
}
```

Thread `applyOptimisticTargetEdits` and (for the active file) the editor's cell list down to the panel as props. In `ProjectWorkspace.tsx`, pass `applyOptimisticTargetEdits` from `useCells` to the dialog, and change `onImported` from `() => revalidateCells()` to a **debounced, single** reconciliation that fires when the active file's pending commits drain (Task 8 wires the drain trigger; here just stop the immediate full refetch):

```tsx
// ProjectWorkspace.tsx:3718
onImported={() => { /* reconciliation handled by drain-complete effect (Task 8) */ }}
```

Apply the same three-step `handleApply` shape to `PairedImportPanel.tsx` and the `ImportDialog` target step (it already has a progress bar — keep it, but it now reflects near-instant enqueue and the dialog closes without waiting on the network).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/import/FileTargetImportPanel.test.tsx src/components/import/PairedImportPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/import/FileTargetImportPanel.tsx src/components/import/PairedImportPanel.tsx src/components/ImportDialog.tsx src/components/ProjectWorkspace.tsx src/components/import/FileTargetImportPanel.test.tsx src/components/import/PairedImportPanel.test.tsx
git commit -m "feat(import): optimistic + background target import in the three import panels"
```

---

## Task 8: Single soft refetch when the active file's import drains

**Why:** Once the outbox drains the imported commits, `rowsRef` must pull the confirmed server projection so optimistic shadows clear (`clearConfirmedShadows`) and validated/word-count/event-id land. Do this as ONE soft `revalidateCells()` triggered when the active-file pending commit count falls to zero — not per-cell.

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx` (add a drain-complete effect near the outbox wiring)
- Test: `src/components/ProjectWorkspace.test.tsx` (or a focused hook test)

- [ ] **Step 1: Write the failing test**

```tsx
// ProjectWorkspace.test.tsx
it("soft-refetches once when the active file's pending commits drain to zero", async () => {
  const revalidateCells = vi.fn()
  renderWorkspace({ revalidateCells, activeFileId: "f1" })
  act(() => setActiveFilePending("f1", 5))   // import enqueued
  act(() => setActiveFilePending("f1", 0))   // drained
  await waitFor(() => expect(revalidateCells).toHaveBeenCalledTimes(1))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/ProjectWorkspace.test.tsx -t "drain to zero"`
Expected: FAIL — no such effect yet.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ProjectWorkspace.tsx — near the outbox context consumption
const activeFilePending = useActiveFilePendingCount(project?.id, activeFileId) // count of pending target commits for the active file (derive from useOutbox().records filtered by fileId+kind)
const prevPendingRef = useRef(0)
useEffect(() => {
  const prev = prevPendingRef.current
  prevPendingRef.current = activeFilePending
  // Falling edge to zero after a backlog → reconcile once with the server.
  if (prev > 0 && activeFilePending === 0) {
    revalidateCells()
  }
}, [activeFilePending, revalidateCells])
```

Derive `activeFilePending` from the existing `useOutbox().records` (already reactive, capped) filtered to `r.event.fileId === activeFileId && r.event.kind === "target.cell.commit"`. No new IDB reads.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/ProjectWorkspace.test.tsx -t "drain to zero"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectWorkspace.tsx src/components/ProjectWorkspace.test.tsx
git commit -m "feat(import): one soft refetch on active-file drain-complete (clears optimistic shadows)"
```

---

## Task 9: Large-import volume guard (inspector + count)

**Why:** A full-Bible Paratext **target** import can enqueue tens of thousands of rows. `outboxPendingCount()`/`outboxFailedCount()` are cursor counts (fine). `usePendingOutboxRecords` already caps at `maxResults=500` (reads 1000) — confirm the inspector renders "showing N of M" rather than attempting all rows, and the badge shows the true count.

**Files:**
- Modify: `src/components/OutboxInspectorPopover.tsx` (display cap + "+N more")
- Test: `src/components/OutboxInspectorPopover.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// OutboxInspectorPopover.test.tsx
it("caps the rendered record list and shows an overflow count", () => {
  render(<OutboxInspectorPopover pendingCount={5000} records={makeRecords(500)} failedCount={0} />)
  expect(screen.getAllByTestId("outbox-record").length).toBeLessThanOrEqual(100)
  expect(screen.getByText(/more/i)).toBeInTheDocument() // "+4900 more queued"
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/OutboxInspectorPopover.test.tsx -t "caps the rendered"`
Expected: FAIL — list renders all provided records, no overflow note.

- [ ] **Step 3: Write minimal implementation**

```tsx
// OutboxInspectorPopover.tsx — before mapping records
const DISPLAY_CAP = 100
const shown = sortedRecords.slice(0, DISPLAY_CAP)
const overflow = Math.max(0, pendingCount - shown.length)
// render `shown`, then:
{overflow > 0 && <p className="text-xs text-muted-foreground px-2 py-1">+{overflow} more queued…</p>}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/OutboxInspectorPopover.test.tsx -t "caps the rendered"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/OutboxInspectorPopover.tsx src/components/OutboxInspectorPopover.test.tsx
git commit -m "fix(sync): cap outbox inspector list with overflow count for large imports"
```

---

## Task 10: End-to-end verification + perf proof

**Files:**
- Use: `verify-dev-change` skill (dev stack as seeded user) + Playwright
- Optional: `src/__tests__/e2e/import-optimistic.spec.ts` (extend the existing import smoke)

- [ ] **Step 1: Full unit/integration suite**

Run: `pnpm vitest run`
Expected: PASS (no skips — Rule 12).

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm tsc -b && pnpm lint`
Expected: clean.

- [ ] **Step 3: Drive the real UI (verify-dev-change skill)**

Launch the worktree dev stack; sign in as the seeded dev user; open a project file; import a translation file (USFM or CSV) of ~200–1000 target cells. Assert with the preview tools:
- Imported text appears in the editor **before** the network settles (optimistic overlay; `hasPendingEdit` styling).
- The sync badge shows a pending count that ticks down (`OutboxSyncIndicator`).
- After the drain, cells lose pending styling and show validated/server state (one soft refetch).
- Force one rejection (e.g. stale parent) and confirm the cell reverts + the rejected record appears in the inspector with a retry affordance.

- [ ] **Step 4: Perf proof (the original complaint)**

Instrument with `performance.now()` splits (reuse `perfMark`): time from "Import" click → first imported cell painted (should be ~immediate, bounded by parse), and total drain time. Compare against pre-change baseline (blocking POST loop + full refetch). Capture a screenshot + the timing numbers and report them.

- [ ] **Step 5: Commit any e2e/test additions**

```bash
git add src/__tests__/e2e/import-optimistic.spec.ts
git commit -m "test(import): e2e + perf proof for optimistic background import"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** instant-feel = Tasks 1–4,7 (enqueue + optimistic overlay/shadow + immediate close); reuse pending badge = native via outbox (Tasks 3,9); keep-content + retry banner = native (`failed` status + inspector, verified Task 10 §3); all bulk target writes = both `bulkUploadTargetCommits` callers re-pointed (Task 3); drain not crawling = Task 5; no rebuild storm = Task 6; reconciliation without fan-out = Task 8; large-import safety = Task 9.
- **Conflict surfaced (Rule 7):** this reverses the earlier "keep the dedicated uploader" (option A) recommendation; option B (outbox) was chosen because the badge/retry/dead-letter are outbox-driven, making A net-new UI. The throttle fix (Task 5) is the price, and it independently fixes the batch-validation lag.
- **Out of scope, flag for follow-up:** main-thread parsing (worker offload); applying the same optimistic+outbox treatment to source/morph imports.
- **Type consistency:** `enqueueOutboxEvents` (Task 1) ← `enqueueEvents` (Task 2) ← `enqueueTargetCommits` (Task 3); `applyOptimisticTargetEdits` used identically in Tasks 4 and 7; `activeFilePending` derived from `useOutbox().records` in Task 8.
- **Verify reconciliation (Rule 9/12):** Task 10 §3 must observe an actual rejected record reverting — a test that can't see the revert is insufficient.
