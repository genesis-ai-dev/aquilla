// The validation pill must not flash back to the server's pre-click state in
// the gap between the outbox record being acknowledged (deleted from IDB) and
// the targeted stats refetch landing. Drives the real outbox + a mocked fetch.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  removeOutboxEvents,
  peekOutboxBatch,
  quarantineOutboxEvents,
  resetOutboxConnectionForTests,
} from "@/lib/sync/outbox"
import type { CqrsRawEvent } from "@/lib/sync/outbox-types"
import { CQRS_SCHEMA_VERSION } from "@/lib/sync/outbox-types"
import { useCellsAuditStatsWithOverlay } from "./useCellsAuditStatsWithOverlay"

vi.mock("@/lib/sync/sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.com",
}))

const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch })

const TOKEN_FN = vi.fn().mockResolvedValue("jwt")

const serverRow = (validators: string[]) => ({
  cellId: "cell-1", editCount: 1, contentHash: "h", lastEditAt: 500, lastEditEventId: "edit-1", activeValidators: validators,
})

const validateEvent = (id: string): CqrsRawEvent<"cell.validate"> => ({
  id, schemaVersion: CQRS_SCHEMA_VERSION, kind: "cell.validate", projectId: "proj-a", fileId: "file-x",
  cellId: "cell-1", author: "ann", payload: { editEventId: "edit-1" }, clientTs: Date.now(),
})

/** fetch mock whose answer for cell-1 is whatever `validators` holds at call time. */
function installFetch(validators: { current: string[] }) {
  global.fetch = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ cells: [serverRow(validators.current)] }), { status: 200 }),
  ) as unknown as typeof fetch
}

beforeEach(async () => {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve) => {
    const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    d.onsuccess = () => resolve()
    d.onerror = () => resolve()
    d.onblocked = () => resolve()
  })
})

describe("useCellsAuditStatsWithOverlay — post-flush shadow", () => {
  it("holds the vote across ack→refetch, then shows the server's answer", async () => {
    const server = { current: [] as string[] }
    installFetch(server)
    const { result } = renderHook(() =>
      useCellsAuditStatsWithOverlay({ enabled: true, fileId: "file-x", getTokenForFile: TOKEN_FN }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual([])

    // click → pending record → overlay
    await act(async () => { await enqueueOutboxEvent(validateEvent("v1")) })
    await waitFor(() => expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["ann"]))

    // flusher acks: record gone, server map still pre-click → must NOT flash
    await act(async () => { await removeOutboxEvents(["v1"]) })
    // prove we are IN the gap: IDB is empty, the subscription has had a turn to
    // re-render, and no refetch has fired — then assert the pill never dropped
    await waitFor(async () => expect(await peekOutboxBatch(10)).toHaveLength(0))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["ann"])

    // the targeted refetch lands with the projected vote → shadow releases
    server.current = ["ann"]
    act(() => { result.current.revalidateCellStats("cell-1") })
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2))
    expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["ann"])

    // and a later server retraction is honoured (the shadow is not sticky)
    server.current = []
    act(() => { result.current.revalidateCellStats("cell-1") })
    await waitFor(() => expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual([]))
  })

  it("drops a quarantined vote at once instead of shadowing it", async () => {
    const server = { current: [] as string[] }
    installFetch(server)
    const { result } = renderHook(() =>
      useCellsAuditStatsWithOverlay({ enabled: true, fileId: "file-x", getTokenForFile: TOKEN_FN }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => { await enqueueOutboxEvent(validateEvent("v1")) })
    await waitFor(() => expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["ann"]))

    await act(async () => { await quarantineOutboxEvents(["v1"], { status: 403, reason: "refused" }) })
    await waitFor(() => expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual([]))
  })
})
