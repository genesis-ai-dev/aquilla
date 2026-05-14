import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchProjectSearch, SearchReadError } from "./search-read"

vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.com",
}))

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

describe("fetchProjectSearch", () => {
  it("constructs the correct URL with q + optional side + limit", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchProjectSearch("proj-a", "hello", { side: "target", limit: 25 }, "jwt")
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("q=hello")
    expect(url).toContain("side=target")
    expect(url).toContain("limit=25")
    expect(url.startsWith("https://sync.example.com/api/v1/projects/proj-a/search?")).toBe(true)
  })

  it("returns the results array on a 200 response", async () => {
    const results = [
      {
        cellId: "c1",
        fileId: "f1",
        side: "target" as const,
        value: "hola",
        snippet: "h<mark>o</mark>la",
        rank: -3.2,
      },
    ]
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ results }), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchProjectSearch("proj-a", "o", {}, "jwt")
    expect(out).toEqual(results)
  })

  it("throws SearchReadError on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("bad", { status: 400 }),
    ) as unknown as typeof fetch
    await expect(fetchProjectSearch("proj-a", "x", {}, "jwt")).rejects.toBeInstanceOf(
      SearchReadError,
    )
  })

  it("omits side / limit when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchProjectSearch("proj-a", "hi", {}, "jwt")
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).not.toContain("side=")
    expect(url).not.toContain("limit=")
  })
})
