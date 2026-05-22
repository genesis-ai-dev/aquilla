/**
 * Unit tests for outbox-flush.ts
 *
 * Tests flushOutboxBatch with a mocked fetch (injected via FlushDeps.fetchImpl)
 * and a real IDB-backed outbox (fake-indexeddb/auto via src/test-setup.ts).
 *
 * Key scenarios:
 *   - Empty outbox / no token: does not call fetch
 *   - Happy path: all events accepted, removed from outbox
 *   - Partial accept: permanent validation rejects are dropped from outbox
 *   - Network throw / non-2xx: networkError=true, outbox unchanged
 *   - Auth failures stay in outbox so a fresh token / restored role can retry
 *   - Per-file batching: only oldest-file events are sent per call
 *   - Records without fileId: dropped from outbox
 *   - Body parse failure: treated as network error
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { flushOutboxBatch } from "./outbox-flush"
import {
  enqueueOutboxEvent,
  outboxPendingCount,
  resetOutboxConnectionForTests,
} from "./outbox"
import type { CqrsRawEvent } from "./cqrs-types"
import { CQRS_SCHEMA_VERSION } from "./cqrs-types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _eventSeq = 0

function makeEvent(
  id: string,
  fileId?: string,
  overrides: Partial<CqrsRawEvent<"target.cell.commit">> = {},
): CqrsRawEvent<"target.cell.commit"> {
  return {
    id,
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: "proj",
    fileId,
    cellId: "cell-1",
    author: "tester",
    payload: { value: "v", valueHtml: "<p>v</p>" },
    clientTs: ++_eventSeq,
    ...overrides,
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const TOKEN_FN = async (_fid: string): Promise<string | null> => "tok"
const NULL_TOKEN_FN = async (_fid: string): Promise<string | null> => null

async function resetIdb(): Promise<void> {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    d.onblocked = () => resolve()
    d.onsuccess = () => resolve()
    d.onerror = () => reject(d.error)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flushOutboxBatch", () => {
  beforeEach(async () => {
    _eventSeq = 0
    await resetIdb()
  })

  // -- Empty outbox ----------------------------------------------------------

  it("returns { posted:0, accepted:0, networkError:false } and does not call fetch when outbox is empty", async () => {
    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ posted: 0, accepted: 0, networkError: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // -- No-token path ---------------------------------------------------------

  it("returns { posted:0, accepted:0, networkError:false } and does not call fetch when token is null", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: NULL_TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ posted: 0, accepted: 0, networkError: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // -- Happy path ------------------------------------------------------------

  it("POSTs 3 events with bearer auth; removes all from outbox on full accept", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: [{ id: "e1" }, { id: "e2" }, { id: "e3" }], rejected: [] }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain("/events")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok")

    const bodyEvents = JSON.parse(init.body as string).events as CqrsRawEvent[]
    expect(bodyEvents).toHaveLength(3)

    expect(result).toEqual({ posted: 3, accepted: 3, networkError: false })
    expect(await outboxPendingCount()).toBe(0)
  })

  // -- Partial accept --------------------------------------------------------

  it("removes accepted events and permanent 400 rejected events", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "e1" }],
        rejected: [
          { id: "e2", status: 400, reason: "bad payload" },
          { id: "e3", status: 400, reason: "bad payload" },
        ],
      }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ posted: 3, accepted: 1, networkError: false })
    expect(await outboxPendingCount()).toBe(0)
  })

  it("keeps per-event 401 and 403 rejects in the outbox for auth retry", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "e1" }],
        rejected: [
          { id: "e2", status: 401, reason: "token expired" },
          { id: "e3", status: 403, reason: "role too low for cell.commit" },
        ],
      }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ posted: 3, accepted: 1, networkError: false })
    expect(await outboxPendingCount()).toBe(2)
  })

  // -- Network throw ---------------------------------------------------------

  it("returns networkError:true and leaves outbox unchanged when fetch throws", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ posted: 3, accepted: 0, networkError: true })
    expect(await outboxPendingCount()).toBe(3)
  })

  // -- Non-2xx response ------------------------------------------------------

  it("returns networkError:true and leaves outbox unchanged on 500 response", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }))
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ posted: 3, accepted: 0, networkError: true })
    expect(await outboxPendingCount()).toBe(3)
  })

  // -- Auth failure ----------------------------------------------------------

  it(
    "fetch returns 401 → networkError:true and events stay in outbox for retry",
    async () => {
      await enqueueOutboxEvent(makeEvent("e1", "f1"))

      const fetchMock = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }))
      const result = await flushOutboxBatch({
        getTokenForFile: TOKEN_FN,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      // Matches transient network error behavior — same as 500 or fetch throw
      expect(result.networkError).toBe(true)
      expect(result.accepted).toBe(0)
      expect(await outboxPendingCount()).toBe(1)
    },
  )

  // -- Per-file batching -----------------------------------------------------

  it("groups oldest-file-first: only f1 events are posted when f1 events are older than f2 events", async () => {
    // Enqueue in alternating order — f1 first so it is the "oldest file"
    await enqueueOutboxEvent(makeEvent("f1-e1", "f1"))
    await enqueueOutboxEvent(makeEvent("f2-e1", "f2"))
    await enqueueOutboxEvent(makeEvent("f1-e2", "f1"))
    await enqueueOutboxEvent(makeEvent("f2-e2", "f2"))
    await enqueueOutboxEvent(makeEvent("f1-e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "f1-e1" }, { id: "f1-e2" }, { id: "f1-e3" }],
        rejected: [],
      }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const bodyEvents = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ).events as CqrsRawEvent[]
    // Only f1 events should be in the request body
    expect(bodyEvents.map((e) => e.fileId)).toEqual(["f1", "f1", "f1"])

    expect(result).toEqual({ posted: 3, accepted: 3, networkError: false })
    // f2 events must still be in the outbox
    expect(await outboxPendingCount()).toBe(2)
  })

  // -- Starvation: document current "oldest file wins" behavior --------------

  it(
    "STARVATION NOTE (DOCUMENTING current behavior): " +
      "each flush call sends only the oldest file's events; " +
      "if f1 is always older than f2, f2 will starve until f1 is drained",
    async () => {
      // This test locks in the "oldest file wins per call" semantics so a future
      // refactor (e.g. round-robin) can't silently change them without failing here.
      //
      // The outbox sorts by enqueuedAt. We enqueue f1 first, then f2 separately
      // to ensure different timestamps (even on fast hardware where Date.now()
      // might return the same ms, the sequential async enqueue guarantees f1's
      // enqueuedAt <= f2's enqueuedAt, and the IDB index preserves insertion order
      // for equal keys — so f1 remains "oldest").
      // Enqueue with explicit different enqueuedAt values by overriding via IDB directly
      // is not possible here, so we rely on insertion order for equal-key cursors.
      // Giving the events unique IDs that sort before "f2" ensures f1 is always first.
      await enqueueOutboxEvent(makeEvent("starvation-a-f1", "f1"))
      await enqueueOutboxEvent(makeEvent("starvation-b-f2", "f2"))

      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ accepted: [{ id: "starvation-a-f1" }], rejected: [] }),
      )
      await flushOutboxBatch({
        getTokenForFile: TOKEN_FN,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      // Only "f1" was flushed this round — f2 is still waiting
      const remaining = await outboxPendingCount()
      expect(remaining).toBe(1)

      const bodyEvents = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      ).events as CqrsRawEvent[]
      // All events in the POST body must be from f1
      expect(bodyEvents.every((e) => e.fileId === "f1")).toBe(true)
    },
  )

  // -- Records without fileId ------------------------------------------------

  it("drops records without fileId so they cannot poison the outbox", async () => {
    // An event with no fileId ends up as the only / first record
    const noFileEvent = makeEvent("no-file", undefined)
    await enqueueOutboxEvent(noFileEvent)

    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ posted: 0, accepted: 0, networkError: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await outboxPendingCount()).toBe(0)
  })

  // -- Body parse failure ----------------------------------------------------

  it("returns networkError:true and leaves outbox unchanged when server returns 200 with non-JSON body", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not json at all", { status: 200 }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toEqual({ posted: 3, accepted: 0, networkError: true })
    expect(await outboxPendingCount()).toBe(3)
  })
})
