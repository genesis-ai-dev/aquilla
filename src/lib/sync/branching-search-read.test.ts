import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { branchingResponseToScoredPairs, fetchBranchingSearch } from "./branching-search-read"
import { fetchBranchingSearchPassages } from "./branching-search-passages-read"

vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.com",
}))

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

function mockOk(body: unknown) {
  global.fetch = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as typeof fetch
}

function requestedUrl(): string {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
}

describe("fetchBranchingSearch targetLang (AQU-1025)", () => {
  it("always sets targetLang=French on the query string", async () => {
    mockOk({ results: [], provenance: {}, upstreamProjectId: null, corpusEventMax: null, corpusSize: 0 })
    await fetchBranchingSearch({
      projectId: "proj-a",
      query: "God called the light",
      jwt: "jwt",
      validatedOnly: true,
      targetLang: "French",
    })
    const url = new URL(requestedUrl())
    expect(url.searchParams.get("targetLang")).toBe("French")
  })

  it("sets targetLang= for the default lane", async () => {
    mockOk({ results: [], provenance: {}, upstreamProjectId: null, corpusEventMax: null, corpusSize: 0 })
    await fetchBranchingSearch({
      projectId: "proj-a",
      query: "God called the light",
      jwt: "jwt",
      targetLang: "",
    })
    const url = new URL(requestedUrl())
    expect(url.searchParams.get("targetLang")).toBe("")
  })
})

describe("fetchBranchingSearchPassages targetLang (AQU-1025)", () => {
  it("always sets targetLang=French on the query string", async () => {
    mockOk({ passages: [], upstreamProjectId: null, corpusEventMax: null, corpusSize: 0 })
    await fetchBranchingSearchPassages({
      projectId: "proj-a",
      query: "God called the light",
      jwt: "jwt",
      validatedOnly: true,
      targetLang: "French",
    })
    const url = new URL(requestedUrl())
    expect(url.searchParams.get("validatedOnly")).toBe("true")
    expect(url.searchParams.get("targetLang")).toBe("French")
  })

  it("sets targetLang= for the default lane", async () => {
    mockOk({ passages: [], upstreamProjectId: null, corpusEventMax: null, corpusSize: 0 })
    await fetchBranchingSearchPassages({
      projectId: "proj-a",
      query: "God called the light",
      jwt: "jwt",
      targetLang: "",
    })
    const url = new URL(requestedUrl())
    expect(url.searchParams.get("targetLang")).toBe("")
  })
})

// AQU-1393: the Examples panel names each match's origin from the pair's
// `fileId`. The single-cell draft's adapter used to blank it, so no origin line
// — and never `TM · <file>` — could render after "Translate with AI".
describe("branchingResponseToScoredPairs (AQU-1393)", () => {
  // The body as the sync-worker route serialises it.
  const body = {
    results: [
      { cellId: "tu-1", sourceText: "In the beginning", targetText: "Au commencement", queryCoverage: 1, fileId: "file-tmx" },
      { cellId: "gen-1", sourceText: "In the beginning God", targetText: "Au commencement Dieu", queryCoverage: 0.75, fileId: "file-gen" },
    ],
    provenance: { "tu-1": ["in", "the", "beginning"] },
    upstreamProjectId: null,
    corpusEventMax: "ev-9",
    corpusSize: 2,
  }

  it("carries each hit's file id through a fetched response", async () => {
    mockOk(body)
    const res = await fetchBranchingSearch({ projectId: "proj-a", query: "In the beginning", jwt: "jwt" })
    expect(branchingResponseToScoredPairs(res)).toEqual([
      {
        cellId: "tu-1", fileId: "file-tmx", source: "In the beginning", target: "Au commencement",
        score: 1, matchedTokens: ["in", "the", "beginning"], coverageWeight: 1,
      },
      {
        cellId: "gen-1", fileId: "file-gen", source: "In the beginning God", target: "Au commencement Dieu",
        score: 1, matchedTokens: [], coverageWeight: 0.75,
      },
    ])
  })

  it("falls back to an empty file id for a response cached before the field existed", () => {
    const legacy = {
      ...body,
      results: body.results.map((r) => ({
        cellId: r.cellId, sourceText: r.sourceText, targetText: r.targetText, queryCoverage: r.queryCoverage,
      })),
    }
    expect(branchingResponseToScoredPairs(legacy).map((p) => p.fileId)).toEqual(["", ""])
  })
})
