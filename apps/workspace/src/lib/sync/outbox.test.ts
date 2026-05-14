import { describe, it, expect, vi, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  markOutboxAttempt,
  peekOutboxBatch,
  removeOutboxEvents,
  outboxPendingCount,
  resetOutboxConnectionForTests,
} from "./outbox"
import type { CqrsRawEvent } from "./cqrs-types"
import { CQRS_SCHEMA_VERSION } from "./cqrs-types"
import { flushOutboxBatch } from "./outbox-flush"

describe("cqrs outbox", () => {
  const sample: CqrsRawEvent<"cell.commit"> = {
    id: "e1",
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "cell.commit",
    projectId: "p",
    fileId: "f",
    cellId: "c",
    author: "a",
    payload: { value: "x", valueHtml: "<p>x</p>" },
    clientTs: 1,
  }

  beforeEach(async () => {
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("codex-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("enqueue, peek, remove", async () => {
    expect(await outboxPendingCount()).toBe(0)
    await enqueueOutboxEvent(sample)
    expect(await outboxPendingCount()).toBe(1)
    const peek = await peekOutboxBatch(10)
    expect(peek).toHaveLength(1)
    expect(peek[0].event.id).toBe("e1")
    expect(peek[0].attempts).toBe(0)
    expect(peek[0].lastAttemptAt).toBe(null)
    expect(peek[0].lastError).toBe(null)
    await removeOutboxEvents(["e1"])
    expect(await outboxPendingCount()).toBe(0)
  })

  it("markOutboxAttempt records attempts and lastError on existing rows", async () => {
    await enqueueOutboxEvent(sample)
    await markOutboxAttempt(["e1"], {
      error: { status: 401, reason: "token expired" },
      at: 1700,
    })
    const peek = await peekOutboxBatch(10)
    expect(peek[0].attempts).toBe(1)
    expect(peek[0].lastAttemptAt).toBe(1700)
    expect(peek[0].lastError).toEqual({ status: 401, reason: "token expired" })

    // Subsequent attempt bumps the counter and overwrites lastError.
    await markOutboxAttempt(["e1"], {
      error: { status: 403, reason: "role too low" },
      at: 1800,
    })
    const peek2 = await peekOutboxBatch(10)
    expect(peek2[0].attempts).toBe(2)
    expect(peek2[0].lastError).toEqual({ status: 403, reason: "role too low" })
  })

  it("markOutboxAttempt is a no-op for ids not in the store", async () => {
    await enqueueOutboxEvent(sample)
    await markOutboxAttempt(["does-not-exist"], {
      error: { status: 500, reason: "boom" },
    })
    const peek = await peekOutboxBatch(10)
    // Original record is untouched.
    expect(peek[0].attempts).toBe(0)
    expect(peek[0].lastError).toBe(null)
  })

  it("flushOutboxBatch records auth quarantine on 401 rejected rows", async () => {
    await enqueueOutboxEvent(sample)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: [],
          rejected: [{ id: "e1", status: 401, reason: "unauth" }],
        }),
        { status: 200 },
      ),
    )
    await flushOutboxBatch({
      getTokenForFile: async () => "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    // The 401-rejected event stays in the outbox (auth quarantine).
    expect(await outboxPendingCount()).toBe(1)
    const peek = await peekOutboxBatch(10)
    expect(peek[0].attempts).toBe(1)
    expect(peek[0].lastError).toEqual({ status: 401, reason: "unauth" })
  })

  it("flushOutboxBatch POSTs and removes accepted rows", async () => {
    await enqueueOutboxEvent(sample)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: [{ id: "e1" }], rejected: [] }), {
        status: 200,
      }),
    )
    await flushOutboxBatch({
      getTokenForFile: async () => "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain("/events")
    expect(init.method).toBe("POST")
    expect(await outboxPendingCount()).toBe(0)
  })
})
