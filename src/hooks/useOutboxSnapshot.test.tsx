/**
 * AQU-2655: OutboxProvider publishes the outbox to every `useOutbox()` consumer,
 * and the largest of them is the whole project workspace. Each change of the
 * published value is one workspace render, so one outbox change must be one
 * change of the snapshot, never one per field, and no render may see fields
 * that disagree (0 pending beside 2 records).
 */
import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvents,
  quarantineOutboxEvents,
  removeOutboxEvents,
  resetOutboxConnectionForTests,
} from "@/lib/sync/outbox"
import type { CqrsRawEvent } from "@/lib/sync/outbox-types"
import { CQRS_SCHEMA_VERSION } from "@/lib/sync/outbox-types"
import { useOutboxSnapshot, type OutboxSnapshot } from "./useOutboxSnapshot"

const makeEvent = (id: string): CqrsRawEvent<"target.cell.commit"> => ({
  id,
  schemaVersion: CQRS_SCHEMA_VERSION,
  kind: "target.cell.commit",
  projectId: "proj-a",
  fileId: "file-x",
  cellId: `cell-${id}`,
  author: "alice",
  payload: { value: `value-${id}`, valueHtml: `<p>value-${id}</p>` },
  clientTs: Date.now(),
})

beforeEach(async () => {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve) => {
    const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    d.onsuccess = () => resolve()
    d.onerror = () => resolve()
    d.onblocked = () => resolve()
  })
})

/** Renders the hook and keeps every distinct snapshot it returned. */
function renderSnapshot(flusher = { flusherPendingCount: 0, flusherFailedCount: 0 }) {
  const seen: OutboxSnapshot[] = []
  const hook = renderHook(
    (props: { enabled: boolean; flusherPendingCount: number; flusherFailedCount: number }) => {
      const snapshot = useOutboxSnapshot(props)
      if (seen[seen.length - 1] !== snapshot) seen.push(snapshot)
      return snapshot
    },
    { initialProps: { enabled: true, ...flusher } },
  )
  return { ...hook, seen }
}

describe("useOutboxSnapshot", () => {
  it("publishes one outbox change as one snapshot whose fields agree", async () => {
    const { result, seen } = renderSnapshot()
    await waitFor(() => expect(result.current.pendingCount).toBe(0))
    const before = seen.length

    await act(async () => {
      await enqueueOutboxEvents([makeEvent("ev1"), makeEvent("ev2")])
    })
    await waitFor(() => expect(result.current.pendingCount).toBe(2))
    expect(seen.length - before).toBe(1)
    expect(result.current.records.map((r) => r.id)).toEqual(["ev1", "ev2"])
    expect(result.current.inspectorRecords.map((r) => r.id)).toEqual(["ev1", "ev2"])

    const enqueued = seen.length
    await act(async () => {
      await removeOutboxEvents(["ev1", "ev2"])
    })
    await waitFor(() => expect(result.current.pendingCount).toBe(0))
    expect(seen.length - enqueued).toBe(1)
    expect(result.current.records).toEqual([])
    expect(result.current.inspectorRecords).toEqual([])
  })

  it("keeps a quarantined record out of the overlay list and in the inspector list", async () => {
    await enqueueOutboxEvents([makeEvent("ev1"), makeEvent("ev2")])
    const { result } = renderSnapshot()
    await waitFor(() => expect(result.current.pendingCount).toBe(2))

    await act(async () => {
      await quarantineOutboxEvents(["ev1"], { status: 403, reason: "forbidden" })
    })
    await waitFor(() => expect(result.current.failedCount).toBe(1))
    // Total still counts the failed record; the overlay list must not replay it (AQU-274).
    expect(result.current.pendingCount).toBe(2)
    expect(result.current.records.map((r) => r.id)).toEqual(["ev2"])
    expect(result.current.inspectorRecords.map((r) => r.id)).toEqual(["ev1", "ev2"])
  })

  it("keeps the overlay list's identity when only a failed record's bookkeeping changes", async () => {
    await enqueueOutboxEvents([makeEvent("ev1"), makeEvent("ev2")])
    const { result } = renderSnapshot()
    await waitFor(() => expect(result.current.pendingCount).toBe(2))
    await act(async () => {
      await quarantineOutboxEvents(["ev1"], { status: 403, reason: "forbidden" })
    })
    await waitFor(() => expect(result.current.failedCount).toBe(1))
    const overlay = result.current.records

    await act(async () => {
      await quarantineOutboxEvents(["ev1"], { status: 403, reason: "still forbidden" })
    })
    await waitFor(() => expect(result.current.inspectorRecords[0].lastError?.reason).toBe("still forbidden"))
    expect(result.current.records).toBe(overlay)
  })

  it("re-reads when the flusher's count moves without an outbox notification", async () => {
    const { result, rerender } = renderSnapshot()
    await waitFor(() => expect(result.current.pendingCount).toBe(0))

    // Another tab's write reaches IndexedDB but sends this tab no notification.
    // Dropping the listeners stands in for that.
    await resetOutboxConnectionForTests()
    await enqueueOutboxEvents([makeEvent("ev1")])
    expect(result.current.pendingCount).toBe(0)

    // The flusher's periodic count is how this tab learns of it.
    rerender({ enabled: true, flusherPendingCount: 1, flusherFailedCount: 0 })
    await waitFor(() => expect(result.current.pendingCount).toBe(1))
    expect(result.current.records.map((r) => r.id)).toEqual(["ev1"])
  })

  it("reads nothing while disabled and reports the flusher's counts", async () => {
    await enqueueOutboxEvents([makeEvent("ev1")])
    const { result } = renderHook(() =>
      useOutboxSnapshot({ enabled: false, flusherPendingCount: 3, flusherFailedCount: 1 }),
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(result.current).toEqual({ pendingCount: 3, failedCount: 1, records: [], inspectorRecords: [] })
  })
})
