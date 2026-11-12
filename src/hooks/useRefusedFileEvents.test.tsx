/**
 * AQU-797: a `file.delete` the server refuses must be distinguishable from one
 * that simply hasn't flushed yet, because the optimistic overlay that hides the
 * row can only be rolled back on the event's death — the server read still
 * carries the file in both cases.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  quarantineOutboxEvents,
  markOutboxAttempt,
  requeueTransientlyFailedOutboxEvents,
  peekOutboxBatch,
  resetOutboxConnectionForTests,
  OUTBOX_MAX_ATTEMPTS,
} from "@/lib/sync/outbox"
import type { CqrsRawEvent } from "@/lib/sync/outbox-types"
import { CQRS_SCHEMA_VERSION } from "@/lib/sync/outbox-types"
import { useRefusedFileEvents } from "./useRefusedFileEvents"

const makeDelete = (
  id: string,
  opts: { projectId?: string; fileId?: string } = {},
): CqrsRawEvent<"file.delete"> => ({
  id,
  schemaVersion: CQRS_SCHEMA_VERSION,
  kind: "file.delete",
  projectId: opts.projectId ?? "proj-a",
  fileId: opts.fileId ?? "file-x",
  cellId: undefined,
  author: "alice",
  payload: {},
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

describe("useRefusedFileEvents", () => {
  it("reports a 403-quarantined file.delete with its file id and reason", async () => {
    await enqueueOutboxEvent(makeDelete("d1"))
    await quarantineOutboxEvents(["d1"], {
      status: 403,
      reason: "role too low for file.delete",
    })

    const { result } = renderHook(() => useRefusedFileEvents("proj-a", "file.delete"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0]).toMatchObject({
      id: "d1",
      fileId: "file-x",
      reason: "role too low for file.delete",
      status: 403,
    })
  })

  it("ignores a delete that is still pending — the overlay must stand", async () => {
    await enqueueOutboxEvent(makeDelete("d1"))

    const { result } = renderHook(() => useRefusedFileEvents("proj-a", "file.delete"))
    await waitFor(() => expect(result.current).toHaveLength(0))
  })

  it("ignores a network/5xx failure, which the next reconnect revives", async () => {
    await enqueueOutboxEvent(makeDelete("d1"))
    await enqueueOutboxEvent(makeDelete("d2", { fileId: "file-y" }))
    await quarantineOutboxEvents(["d1"], { status: 0, reason: "offline" })
    await quarantineOutboxEvents(["d2"], { status: 503, reason: "HTTP 503" })

    const { result } = renderHook(() => useRefusedFileEvents("proj-a", "file.delete"))
    await waitFor(() => expect(result.current).toHaveLength(0))
    // And they really are revivable — the overlay was right to stand.
    await requeueTransientlyFailedOutboxEvents()
    const revived = await peekOutboxBatch(10)
    expect(revived.map((r) => r.status)).toEqual(["pending", "pending"])
  })

  it("reports a delete that burned its retry budget on a deterministic 4xx", async () => {
    await enqueueOutboxEvent(makeDelete("d1"))
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await markOutboxAttempt(["d1"], { error: { status: 422, reason: "HTTP 422" } })
    }

    const { result } = renderHook(() => useRefusedFileEvents("proj-a", "file.delete"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].status).toBe(422)
  })

  it("filters by project and by kind", async () => {
    await enqueueOutboxEvent(makeDelete("mine"))
    await enqueueOutboxEvent(makeDelete("other-project", { projectId: "proj-b" }))
    await enqueueOutboxEvent({ ...makeDelete("other-kind"), kind: "file.restore" } as CqrsRawEvent)
    await quarantineOutboxEvents(["mine", "other-project", "other-kind"], {
      status: 403,
      reason: "forbidden",
    })

    const { result } = renderHook(() => useRefusedFileEvents("proj-a", "file.delete"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("mine")
  })

  it("returns nothing with no project open, and does not subscribe", async () => {
    await enqueueOutboxEvent(makeDelete("d1"))
    await quarantineOutboxEvents(["d1"], { status: 403, reason: "forbidden" })

    const { result } = renderHook(() => useRefusedFileEvents(null, "file.delete"))
    await waitFor(() => expect(result.current).toHaveLength(0))
  })
})
