import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  BranchingSearchPassagesError,
  fetchBranchingSearchPassages,
} from "./branching-search-passages-read"

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

const SAMPLE_BODY = {
  passages: [
    {
      fileId: "f1",
      hitCellId: "c3",
      cells: [
        { cellId: "c2", sourceText: "before", targetText: "B", anchorCellId: "c1", hit: false },
        { cellId: "c3", sourceText: "hit",    targetText: "H", anchorCellId: "c2", hit: true },
        { cellId: "c4", sourceText: "after",  targetText: "A", anchorCellId: "c3", hit: false },
      ],
    },
  ],
  upstreamProjectId: null,
  corpusEventMax: "e-zzzz",
  corpusSize: 6,
}

describe("fetchBranchingSearchPassages", () => {
  it("returns the response body on 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchBranchingSearchPassages({
      projectId: "p1",
      query: "the cat",
      jwt: "jwt",
    })
    expect(out.passages.length).toBe(1)
    expect(out.passages[0].hitCellId).toBe("c3")
    expect(out.passages[0].cells.find((c) => c.hit)!.cellId).toBe("c3")
  })

  it("includes topK, radius, validatedOnly, excludeCellId in the URL", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearchPassages({
      projectId: "p1",
      query: "x",
      jwt: "jwt",
      topK: 3,
      radius: 1,
      validatedOnly: true,
      excludeCellId: "c-skip",
    })
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("topK=3")
    expect(url).toContain("radius=1")
    expect(url).toContain("validatedOnly=true")
    expect(url).toContain("excludeCellId=c-skip")
  })

  it("throws on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("denied", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(
      fetchBranchingSearchPassages({ projectId: "p1", query: "x", jwt: "jwt" }),
    ).rejects.toBeInstanceOf(BranchingSearchPassagesError)
  })

  it("encodes special characters in projectId", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearchPassages({
      projectId: "p/1",
      query: "x",
      jwt: "jwt",
    })
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("p%2F1")
  })

  it("forwards AbortSignal", async () => {
    const ctrl = new AbortController()
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearchPassages({
      projectId: "p1",
      query: "x",
      jwt: "jwt",
      signal: ctrl.signal,
    })
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.signal).toBe(ctrl.signal)
  })
})
