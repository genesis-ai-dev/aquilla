/**
 * SUB-8 (AQU-633 follow-up): useForbiddenOutboxRecords feeds the "change
 * wasn't saved" banner from quarantined 403 records — and must stop feeding a
 * record once the user acknowledges it (persistent Dismiss), while a requeued
 * record that gets refused again banners anew.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  quarantineOutboxEvents,
  acknowledgeOutboxEvents,
  requeueOutboxEvents,
  resetOutboxConnectionForTests,
} from "@/lib/sync/outbox"
import type { CqrsRawEvent } from "@/lib/sync/outbox-types"
import { CQRS_SCHEMA_VERSION } from "@/lib/sync/outbox-types"
import { useForbiddenOutboxRecords } from "./useForbiddenOutboxRecords"

const makeEvent = (id: string): CqrsRawEvent<"cell.validate"> => ({
  id,
  schemaVersion: CQRS_SCHEMA_VERSION,
  kind: "cell.validate",
  projectId: "proj-a",
  fileId: "file-x",
  cellId: `cell-${id}`,
  author: "alice",
  payload: { editEventId: `edit-${id}` },
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

describe("useForbiddenOutboxRecords", () => {
  it("returns quarantined 403 records with a reason", async () => {
    await enqueueOutboxEvent(makeEvent("v1"))
    await quarantineOutboxEvents(["v1"], { status: 403, reason: "self-validation is not allowed on this project" })

    const { result } = renderHook(() => useForbiddenOutboxRecords(true))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].lastError?.reason).toMatch(/self-validation/)
  })

  it("excludes acknowledged records (persistent Dismiss survives re-derivation)", async () => {
    await enqueueOutboxEvent(makeEvent("v1"))
    await enqueueOutboxEvent(makeEvent("v2"))
    await quarantineOutboxEvents(["v1", "v2"], { status: 403, reason: "forbidden" })
    await acknowledgeOutboxEvents(["v1"])

    const { result } = renderHook(() => useForbiddenOutboxRecords(true))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("v2")
  })

  it("a requeued-then-requarantined record banners again (ack cleared)", async () => {
    await enqueueOutboxEvent(makeEvent("v1"))
    await quarantineOutboxEvents(["v1"], { status: 403, reason: "forbidden" })
    await acknowledgeOutboxEvents(["v1"])
    await requeueOutboxEvents(["v1"])
    await quarantineOutboxEvents(["v1"], { status: 403, reason: "forbidden again" })

    const { result } = renderHook(() => useForbiddenOutboxRecords(true))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].lastError?.reason).toBe("forbidden again")
  })

  it("ignores non-403 failures and pending records", async () => {
    await enqueueOutboxEvent(makeEvent("pending1"))
    await enqueueOutboxEvent(makeEvent("server1"))
    await quarantineOutboxEvents(["server1"], { status: 500, reason: "boom" })

    const { result } = renderHook(() => useForbiddenOutboxRecords(true))
    // settle: give the initial refresh a tick, then assert emptiness
    await waitFor(() => expect(result.current).toHaveLength(0))
  })
})
