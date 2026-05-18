import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  BranchingSearchError,
  fetchBranchingSearch,
} from "./branching-search-read"

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

const SAMPLE_BODY = {
  results: [
    { cellId: "c1", sourceText: "the cat sat", targetText: "le chat", queryCoverage: 1 },
    { cellId: "c2", sourceText: "the dog ran", targetText: "le chien", queryCoverage: 0.5 },
  ],
  provenance: { c1: ["the", "cat"], c2: ["the"] },
  upstreamProjectId: null,
  corpusEventMax: "e-zzzz",
  corpusSize: 2,
}

describe("fetchBranchingSearch", () => {
  it("returns the full response body on 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchBranchingSearch({
      projectId: "p1",
      query: "the cat",
      jwt: "jwt",
    })
    expect(out.results.length).toBe(2)
    expect(out.results[0].cellId).toBe("c1")
    expect(out.provenance.c1).toEqual(["the", "cat"])
    expect(out.upstreamProjectId).toBeNull()
    expect(out.corpusEventMax).toBe("e-zzzz")
  })

  it("encodes q and projectId in the URL", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearch({
      projectId: "p/1",
      query: "the cat & dog",
      jwt: "jwt",
    })
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("p%2F1")
    expect(url).toContain("q=the+cat+%26+dog")
  })

  it("includes topK, validatedOnly, excludeCellId when provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearch({
      projectId: "p1",
      query: "the cat",
      jwt: "jwt",
      topK: 3,
      validatedOnly: true,
      excludeCellId: "c-skip",
    })
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("topK=3")
    expect(url).toContain("validatedOnly=true")
    expect(url).toContain("excludeCellId=c-skip")
  })

  it("omits optional params when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearch({
      projectId: "p1",
      query: "the cat",
      jwt: "jwt",
    })
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).not.toContain("topK=")
    expect(url).not.toContain("validatedOnly=")
    expect(url).not.toContain("excludeCellId=")
  })

  it("sends the JWT in the Authorization header", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearch({
      projectId: "p1",
      query: "the cat",
      jwt: "the-token",
    })
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.headers).toMatchObject({ Authorization: "Bearer the-token" })
  })

  it("throws BranchingSearchError on 401", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("missing token", { status: 401 }),
    ) as unknown as typeof fetch
    await expect(
      fetchBranchingSearch({ projectId: "p1", query: "x", jwt: "jwt" }),
    ).rejects.toBeInstanceOf(BranchingSearchError)
  })

  it("throws BranchingSearchError on 500", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("server crash", { status: 500 }),
    ) as unknown as typeof fetch
    await expect(
      fetchBranchingSearch({ projectId: "p1", query: "x", jwt: "jwt" }),
    ).rejects.toBeInstanceOf(BranchingSearchError)
  })

  it("forwards the AbortSignal to fetch", async () => {
    const ctrl = new AbortController()
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_BODY), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchBranchingSearch({
      projectId: "p1",
      query: "x",
      jwt: "jwt",
      signal: ctrl.signal,
    })
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.signal).toBe(ctrl.signal)
  })
})
