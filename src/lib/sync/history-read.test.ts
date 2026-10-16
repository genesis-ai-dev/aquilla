import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchCellHistory, HistoryReadError } from "./history-read"

vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.com",
}))

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

describe("fetchCellHistory", () => {
  it("hits the project-scoped history route and returns events", async () => {
    const events = [
      {
        id: "e1",
        parentId: null,
        kind: "target.cell.commit",
        author: "alice",
        clientTs: 1,
        serverTs: 1,
        serverSeq: 1,
        payload: { value: "hello" },
      },
    ]
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events }), { status: 200 }),
    ) as unknown as typeof fetch

    const result = await fetchCellHistory("proj-a", "file-x", "cell-1", "jwt")
    expect(result).toEqual(events)
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toBe(
      "https://sync.example.com/api/v1/projects/proj-a/files/file-x/cells/cell-1/history",
    )
  })

  it("appends limit to the query string when provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchCellHistory("proj-a", "file-x", "cell-1", "jwt", { limit: 25 })
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("limit=25")
  })

  it("URL-encodes ids", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ events: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchCellHistory("proj/a", "file x", "cell:1", "jwt")
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("proj%2Fa")
    expect(url).toContain("file%20x")
    expect(url).toContain("cell%3A1")
  })
})

// AQU-1248: on a slow or lossy link the first attempt often fails. The read
// retries transient failures with backoff, bounded, and the final error says
// whether the network or the server failed.
describe("fetchCellHistory retry and failure classification", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const ok = () => new Response(JSON.stringify({ events: [] }), { status: 200 })
  const status = (code: number) => new Response("upstream says no", { status: code })
  const timeout = () => new DOMException("signal timed out", "TimeoutError")

  /** Settle the read, stepping through every retry backoff. */
  async function settle<T>(read: Promise<T>) {
    const outcome = read.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    await vi.runAllTimersAsync()
    return outcome
  }

  it("retries transport, timeout and 5xx failures until a load succeeds", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(ok())
    global.fetch = fetchMock as unknown as typeof fetch

    const { value, error } = await settle(fetchCellHistory("proj-a", "file-x", "cell-1", "jwt"))
    expect(error).toBeUndefined()
    expect(value).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // Every attempt gets its own deadline, so a hung first try can't eat the budget.
    const signals = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).signal)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(new Set(signals).size).toBe(3)
  })

  it("backs off 500 ms, then 2 s, between attempts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(timeout())
    global.fetch = fetchMock as unknown as typeof fetch

    const outcome = fetchCellHistory("proj-a", "file-x", "cell-1", "jwt").catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(499)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(outcome).resolves.toBeInstanceOf(HistoryReadError)
  })

  it.each([
    ["a transport failure", () => Promise.reject(new TypeError("Failed to fetch")), { kind: "network", status: 0 }],
    ["a timeout", () => Promise.reject(timeout()), { kind: "network", status: 0 }],
    ["a server error", () => Promise.resolve(status(502)), { kind: "server", status: 502 }],
  ])("gives up after three attempts on %s and classifies it", async (_label, attempt, expected) => {
    const fetchMock = vi.fn(attempt)
    global.fetch = fetchMock as unknown as typeof fetch

    const { error } = await settle(fetchCellHistory("proj-a", "file-x", "cell-1", "jwt"))
    expect(error).toBeInstanceOf(HistoryReadError)
    expect(error).toMatchObject(expected)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([401, 403, 404])("fails a deterministic %i on the first attempt as a server error", async (code) => {
    const fetchMock = vi.fn().mockResolvedValue(status(code))
    global.fetch = fetchMock as unknown as typeof fetch

    const { error } = await settle(fetchCellHistory("proj-a", "file-x", "cell-1", "jwt"))
    expect(error).toBeInstanceOf(HistoryReadError)
    expect(error).toMatchObject({ kind: "server", status: code, body: "upstream says no" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
