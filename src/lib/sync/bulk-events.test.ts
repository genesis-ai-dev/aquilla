// bulkPostEvents (AQU-1860) — the bulk front door for a large, foreground set
// of already-built events. The guards here are the reasons it exists: one POST
// per chunk instead of 100 events per outbox flush, per-file grouping because
// writes are file-scoped, and no silent success when the server refused part of
// the batch.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { bulkPostEvents, BULK_EVENTS_CHUNK } from "./bulk-events"
import type { CqrsRawEvent } from "./outbox-types"

vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.test",
}))

function event(id: string, fileId: string): CqrsRawEvent {
  return {
    id,
    schemaVersion: 1,
    kind: "source.cell.commit",
    projectId: "p1",
    fileId,
    cellId: `cell-${id}`,
    parentId: "head-1",
    author: "importer",
    payload: { value: id },
    clientTs: 1,
  } as unknown as CqrsRawEvent
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function errResponse(status: number, body = "nope"): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response
}

const getToken = vi.fn(async (_fileId: string): Promise<string | null> => "tok")

type FetchImpl = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

/** A `typeof fetch`-compatible mock, so the args read back fully typed. */
function makeFetch(impl: FetchImpl = async () => okResponse()) {
  return vi.fn(impl)
}

/** The parsed `{ events }` body of one recorded request. */
function sentEvents(init: RequestInit | undefined): Array<{ id: string; fileId: string }> {
  const body = JSON.parse(String(init?.body)) as {
    events: Array<{ id: string; fileId: string }>
  }
  return body.events
}

beforeEach(() => {
  getToken.mockClear().mockResolvedValue("tok")
})

describe("bulkPostEvents", () => {
  it("posts nothing and reports zero for an empty batch", async () => {
    const fetchImpl = makeFetch()
    const result = await bulkPostEvents({ events: [], getToken, fetchImpl })
    expect(result).toEqual({ posted: 0, rejected: [], stale: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(getToken).not.toHaveBeenCalled()
  })

  it("sends one request per chunk, far fewer than the outbox's 100-per-POST", async () => {
    const total = BULK_EVENTS_CHUNK * 2 + 7
    const events = Array.from({ length: total }, (_, i) => event(`e${i}`, "file-a"))
    const fetchImpl = makeFetch()

    const progress: Array<[number, number]> = []
    const result = await bulkPostEvents({
      events,
      getToken,
      fetchImpl,
      onProgress: (posted, t) => progress.push([posted, t]),
    })

    expect(result.posted).toBe(total)
    // 3 requests for 507 events. The outbox would have needed 6 POSTs across
    // at least two 5 s drain cycles.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(progress).toEqual([
      [BULK_EVENTS_CHUNK, total],
      [BULK_EVENTS_CHUNK * 2, total],
      [total, total],
    ])

    const bodies = fetchImpl.mock.calls.map(([, init]) => sentEvents(init))
    expect(bodies.map((b) => b.length)).toEqual([
      BULK_EVENTS_CHUNK,
      BULK_EVENTS_CHUNK,
      7,
    ])
    expect(fetchImpl.mock.calls[0][0]).toBe("https://sync.test/events")
  })

  it("never mixes files in one request, and mints a token per file", async () => {
    // authorize() requires the event's fileId to be in the token's `file`
    // scopes, so a mixed chunk would 403 on everything but the first file.
    const events = [
      event("a1", "file-a"),
      event("b1", "file-b"),
      event("a2", "file-a"),
      event("c1", "file-c"),
    ]
    const fetchImpl = makeFetch()
    await bulkPostEvents({ events, getToken, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const perRequest = fetchImpl.mock.calls.map(([, init]) => sentEvents(init))
    for (const batch of perRequest) {
      expect(new Set(batch.map((e) => e.fileId)).size).toBe(1)
    }
    // Grouping preserves first-seen file order and within-file order.
    expect(perRequest.map((b) => b.map((e) => e.id))).toEqual([
      ["a1", "a2"],
      ["b1"],
      ["c1"],
    ])
    expect(getToken.mock.calls.map(([f]) => f)).toEqual(["file-a", "file-b", "file-c"])
  })

  it("rejects an event with no fileId rather than sending an unauthorizable batch", async () => {
    const bad = { ...event("x", "file-a") } as unknown as Record<string, unknown>
    delete bad.fileId
    const fetchImpl = makeFetch()
    await expect(
      bulkPostEvents({ events: [bad as unknown as CqrsRawEvent], getToken, fetchImpl }),
    ).rejects.toThrow(/no fileId/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("surfaces per-event rejections and stale siblings instead of reporting clean success", async () => {
    const fetchImpl = makeFetch(async () =>
      okResponse({
        rejected: [{ id: "a1", status: 403, reason: "role too low" }],
        stale: [{ id: "a2", fileId: "file-a", cellId: "cell-a2" }],
      }),
    )
    const result = await bulkPostEvents({
      events: [event("a1", "file-a"), event("a2", "file-a")],
      getToken,
      fetchImpl,
    })
    expect(result.posted).toBe(2)
    expect(result.rejected).toEqual([{ id: "a1", status: 403, reason: "role too low" }])
    expect(result.stale).toEqual([{ id: "a2", fileId: "file-a", cellId: "cell-a2" }])
  })

  it("treats a 200 with an unreadable body as accepted, with no per-event detail", async () => {
    const fetchImpl = makeFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json")
      },
      text: async () => "",
    }) as unknown as Response)
    const result = await bulkPostEvents({ events: [event("a1", "file-a")], getToken, fetchImpl })
    expect(result).toEqual({ posted: 1, rejected: [], stale: [] })
  })

  it("retries a transient status and succeeds on a later attempt", async () => {
    const fetchImpl = makeFetch()
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(okResponse())
    const result = await bulkPostEvents({ events: [event("a1", "file-a")], getToken, fetchImpl })
    expect(result.posted).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("re-mints the token once and replays the same chunk on a 401", async () => {
    getToken.mockResolvedValueOnce("tok-1").mockResolvedValueOnce("tok-2")
    const fetchImpl = makeFetch()
      .mockResolvedValueOnce(errResponse(401))
      .mockResolvedValueOnce(okResponse())
    const result = await bulkPostEvents({ events: [event("a1", "file-a")], getToken, fetchImpl })
    expect(result.posted).toBe(1)
    const auths = fetchImpl.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).Authorization,
    )
    expect(auths).toEqual(["Bearer tok-1", "Bearer tok-2"])
    // The replayed chunk is byte-identical, so the server's INSERT OR IGNORE
    // dedupes anything the lost response had already committed.
    const bodies = fetchImpl.mock.calls.map(([, init]) => init?.body)
    expect(bodies[0]).toBe(bodies[1])
  })

  it("fails fast on a non-retryable status without burning the retry budget", async () => {
    const fetchImpl = makeFetch(async () => errResponse(400, "bad event"))
    await expect(
      bulkPostEvents({ events: [event("a1", "file-a")], getToken, fetchImpl }),
    ).rejects.toThrow(/HTTP 400.*bad event/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("throws when no token can be minted, before any request", async () => {
    getToken.mockResolvedValue(null)
    const fetchImpl = makeFetch()
    await expect(
      bulkPostEvents({ events: [event("a1", "file-a")], getToken, fetchImpl }),
    ).rejects.toThrow(/signed out/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("stops at an aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = makeFetch()
    await expect(
      bulkPostEvents({
        events: [event("a1", "file-a")],
        getToken,
        fetchImpl,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Cancelled/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
