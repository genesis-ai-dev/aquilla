import { describe, it, expect, vi, afterEach } from "vitest"
import { bulkUploadSource, type BulkImportCell } from "./bulk-import"

// Stub syncWorkerHttpOrigin so no VITE env lookup is needed.
vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example",
}))

function makeCell(i: number): BulkImportCell {
  return {
    id: `evt-${i}`,
    cellId: `cell-${i}`,
    anchorCellId: i === 0 ? null : `cell-${i - 1}`,
    value: `verse ${i}`,
  }
}

describe("bulkUploadSource", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("throws if getToken returns null", async () => {
    await expect(
      bulkUploadSource({
        projectId: "p1",
        fileId: "f1",
        file: { id: "file-evt", name: "test.txt" },
        cells: [makeCell(0)],
        getToken: async () => null,
      }),
    ).rejects.toThrow(/signed out/)
  })

  it("sends one request for a small batch (< 1500 cells)", async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify({ accepted: 3, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "gen.txt" },
      cells: [makeCell(0), makeCell(1), makeCell(2)],
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = bodies[0] as Record<string, unknown>
    expect(body.projectId).toBe("p1")
    expect(body.fileId).toBe("f1")
    expect((body.cells as unknown[]).length).toBe(3)
    // file meta included on first (only) chunk
    expect(body.file).toBeDefined()
  })

  it("sends multiple chunks for > 1500 cells", async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    const cells = Array.from({ length: 3200 }, (_, i) => makeCell(i))
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "big.txt" },
      cells,
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    // 3200 cells / 1500 per chunk → 3 requests (1500 + 1500 + 200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // file meta only on first chunk
    expect((bodies[0] as Record<string, unknown>).file).toBeDefined()
    expect((bodies[1] as Record<string, unknown>).file).toBeUndefined()
  })

  it("calls onProgress with cumulative count", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 }),
    ) as typeof fetch

    const progress: Array<[number, number]> = []
    const cells = Array.from({ length: 3000 }, (_, i) => makeCell(i))
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "big.txt" },
      cells,
      getToken: async () => "tok",
      onProgress: (u, t) => progress.push([u, t]),
      fetchImpl: fetchMock,
    })

    expect(progress.length).toBe(2)
    expect(progress[0]).toEqual([1500, 3000])
    expect(progress[1]).toEqual([3000, 3000])
  })

  it("throws a readable error on non-OK response", async () => {
    const fetchMock = vi.fn(
      async () => new Response("role too low", { status: 403 }),
    ) as typeof fetch

    await expect(
      bulkUploadSource({
        projectId: "p1",
        fileId: "f1",
        file: { id: "file-evt", name: "test.txt" },
        cells: [makeCell(0)],
        getToken: async () => "tok",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/403/)
  })
})
