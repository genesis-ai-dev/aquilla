import { describe, it, expect, vi, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
  markOutboxAttempt,
  peekOutboxBatch,
  removeOutboxEvents,
  outboxPendingCount,
  outboxFailedCount,
  peekPendingOutboxBatch,
  quarantineOutboxEvents,
  resetOutboxConnectionForTests,
  OUTBOX_MAX_ATTEMPTS,
} from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"
import { CQRS_SCHEMA_VERSION } from "./outbox-types"
import { flushOutboxBatch } from "./outbox-flush"

describe("cqrs outbox", () => {
  const sample: CqrsRawEvent<"target.cell.commit"> = {
    id: "e1",
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit",
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
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
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
      getTokenForFile: async () => ({ token: "tok", status: 200 }),
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
      getTokenForFile: async () => ({ token: "tok", status: 200 }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain("/events")
    expect(init.method).toBe("POST")
    expect(await outboxPendingCount()).toBe(0)
  })

  it("failure cap: record transitions to `failed` after OUTBOX_MAX_ATTEMPTS", async () => {
    await enqueueOutboxEvent(sample)
    const initialPeek = await peekOutboxBatch(10)
    expect(initialPeek[0].status).toBe("pending")

    // Mark attempts up to (but not reaching) the cap — status stays pending.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS - 1; i++) {
      await markOutboxAttempt(["e1"], { error: { status: 500, reason: "server error" } })
    }
    const beforeCap = await peekOutboxBatch(10)
    expect(beforeCap[0].status).toBe("pending")
    expect(beforeCap[0].attempts).toBe(OUTBOX_MAX_ATTEMPTS - 1)

    // One more attempt hits the cap.
    await markOutboxAttempt(["e1"], { error: { status: 500, reason: "server error" } })
    const afterCap = await peekOutboxBatch(10)
    expect(afterCap[0].status).toBe("failed")
    expect(afterCap[0].attempts).toBe(OUTBOX_MAX_ATTEMPTS)

    // outboxFailedCount reflects the transition.
    expect(await outboxFailedCount()).toBe(1)
    // The total count still includes the failed record.
    expect(await outboxPendingCount()).toBe(1)
  })

  it("peekPendingOutboxBatch excludes failed records", async () => {
    await enqueueOutboxEvent(sample)
    const sample2: CqrsRawEvent<"target.cell.commit"> = { ...sample, id: "e2" }
    await enqueueOutboxEvent(sample2)

    // Cap e1 to failed.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await markOutboxAttempt(["e1"], { error: { status: 500, reason: "err" } })
    }

    const pending = await peekPendingOutboxBatch(10)
    expect(pending.map((r) => r.id)).toEqual(["e2"])
  })

  // FRO-274: quarantineOutboxEvents immediately sets status=failed without
  // burning the full retry budget. peekOutboxBatch still returns the quarantined
  // record (inspector visibility); peekPendingOutboxBatch excludes it so the
  // flusher skips it.
  it("quarantineOutboxEvents immediately moves records to failed status", async () => {
    await enqueueOutboxEvent(sample)
    const initial = await peekOutboxBatch(10)
    expect(initial[0].status).toBe("pending")

    await quarantineOutboxEvents(["e1"], { status: 403, reason: "forbidden" })

    // peekOutboxBatch includes the failed record (inspector visibility).
    const all = await peekOutboxBatch(10)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe("failed")
    expect(all[0].lastError).toEqual({ status: 403, reason: "forbidden" })

    // peekPendingOutboxBatch excludes it so the flusher advances past it.
    const pending = await peekPendingOutboxBatch(10)
    expect(pending).toHaveLength(0)

    // outboxFailedCount reflects the quarantine.
    expect(await outboxFailedCount()).toBe(1)
  })
})
