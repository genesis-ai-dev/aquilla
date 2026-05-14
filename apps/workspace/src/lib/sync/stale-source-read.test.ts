import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { StaleSourceError, fetchStaleSourceCells } from "./stale-source-read"

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

describe("fetchStaleSourceCells", () => {
  it("returns the staleCellIds array on 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          projectId: "p1",
          fileId: "f1",
          staleCellIds: ["c1", "c3", "c7"],
          upstreamProjectId: "src",
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    const out = await fetchStaleSourceCells("p1", "f1", "jwt")
    expect(out).toEqual(["c1", "c3", "c7"])
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toMatch(/\/api\/v1\/projects\/p1\/files\/f1\/stale-source$/)
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer jwt",
    })
  })

  it("treats missing `staleCellIds` as []", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ projectId: "p1", fileId: "f1", upstreamProjectId: null }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    const out = await fetchStaleSourceCells("p1", "f1", "jwt")
    expect(out).toEqual([])
  })

  it("throws StaleSourceError on 401", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("missing token", { status: 401 }),
    ) as unknown as typeof fetch
    await expect(
      fetchStaleSourceCells("p1", "f1", "jwt"),
    ).rejects.toBeInstanceOf(StaleSourceError)
  })

  it("encodes special characters in path params", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ projectId: "p1", fileId: "f1", staleCellIds: [], upstreamProjectId: null }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    await fetchStaleSourceCells("p/1", "f/2", "jwt")
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("p%2F1")
    expect(url).toContain("f%2F2")
  })
})
