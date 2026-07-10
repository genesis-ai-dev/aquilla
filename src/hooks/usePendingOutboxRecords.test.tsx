/**
 * AQU-274: usePendingOutboxRecords filters quarantined (failed) records from
 * the overlay view so rejected events don't surface as pending validation/commit
 * state in cell overlays.
 *
 * The outbox inspector shows all statuses (it calls peekOutboxBatch directly);
 * this hook is for overlay consumers (audit-stats overlay, cell pending badges).
 */

import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  quarantineOutboxEvents,
  markOutboxAttempt,
  resetOutboxConnectionForTests,
  OUTBOX_MAX_ATTEMPTS,
} from "@/lib/sync/outbox"
import type { CqrsRawEvent } from "@/lib/sync/outbox-types"
import { CQRS_SCHEMA_VERSION } from "@/lib/sync/outbox-types"
import { usePendingOutboxRecords } from "./usePendingOutboxRecords"

const makeEvent = (id: string, fileId = "file-x"): CqrsRawEvent<"target.cell.commit"> => ({
  id,
  schemaVersion: CQRS_SCHEMA_VERSION,
  kind: "target.cell.commit",
  projectId: "proj-a",
  fileId,
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

describe("usePendingOutboxRecords (AQU-274: overlay excludes failed records)", () => {
  it("returns pending records for the file", async () => {
    await enqueueOutboxEvent(makeEvent("ev1"))
    const { result } = renderHook(() =>
      usePendingOutboxRecords({ enabled: true, fileId: "file-x" }),
    )
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("ev1")
    expect(result.current[0].status).toBe("pending")
  })

  it("excludes quarantined (failed) records from the overlay — inspector keeps them", async () => {
    await enqueueOutboxEvent(makeEvent("ev1"))
    await enqueueOutboxEvent(makeEvent("ev2"))
    const { result } = renderHook(() =>
      usePendingOutboxRecords({ enabled: true, fileId: "file-x" }),
    )
    await waitFor(() => expect(result.current).toHaveLength(2))

    // Quarantine ev1 (non-retryable rejection).
    await act(async () => {
      await quarantineOutboxEvents(["ev1"], { status: 403, reason: "forbidden" })
    })

    // The overlay should now only show ev2 (pending). ev1 is excluded.
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("ev2")
    expect(result.current[0].status).toBe("pending")
  })

  it("excludes records that reach failed status via retry cap (not just direct quarantine)", async () => {
    await enqueueOutboxEvent(makeEvent("ev1"))
    const { result } = renderHook(() =>
      usePendingOutboxRecords({ enabled: true, fileId: "file-x" }),
    )
    await waitFor(() => expect(result.current).toHaveLength(1))

    // Exhaust the retry budget.
    await act(async () => {
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
        await markOutboxAttempt(["ev1"], { error: { status: 500, reason: "server error" } })
      }
    })

    // After hitting the cap the record transitions to `failed` and the overlay
    // drops it — a stuck commit no longer shows as pending validation state.
    await waitFor(() => expect(result.current).toHaveLength(0))
  })

  it("fileId=null returns all pending records across files (excluding failed)", async () => {
    await enqueueOutboxEvent(makeEvent("ev-a", "file-a"))
    await enqueueOutboxEvent(makeEvent("ev-b", "file-b"))
    await quarantineOutboxEvents(["ev-a"], { status: 403, reason: "forbidden" })
    const { result } = renderHook(() =>
      usePendingOutboxRecords({ enabled: true, fileId: null }),
    )
    // ev-b from file-b is pending; ev-a is quarantined and must be excluded.
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("ev-b")
  })

  it("enabled=false returns empty without subscribing", async () => {
    await enqueueOutboxEvent(makeEvent("ev1"))
    const { result } = renderHook(() =>
      usePendingOutboxRecords({ enabled: false, fileId: "file-x" }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toHaveLength(0)
  })
})
