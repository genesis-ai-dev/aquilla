import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchBranchingSearch } from "./branching-search-read"
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
