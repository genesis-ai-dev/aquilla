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

  it("throws HistoryReadError on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(
      fetchCellHistory("proj-a", "file-x", "cell-1", "jwt"),
    ).rejects.toBeInstanceOf(HistoryReadError)
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
