import { describe, it, expect, vi, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  enqueueOutboxEvent,
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
    await removeOutboxEvents(["e1"])
    expect(await outboxPendingCount()).toBe(0)
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
