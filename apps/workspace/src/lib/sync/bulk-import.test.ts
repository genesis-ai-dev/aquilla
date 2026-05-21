import { describe, it, expect, vi } from "vitest"
import { bulkUploadSource, type BulkImportCell } from "./bulk-import"

function makeCells(n: number): BulkImportCell[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ev-${i}`,
    cellId: `c-${i}`,
    anchorCellId: i === 0 ? null : `c-${i - 1}`,
    value: `v${i}`,
  }))
}

const file = { id: "f-ev", name: "Big", kind: "ebible", role: "source" }
const getToken = async () => "tok"

describe("bulkUploadSource", () => {
  it("chunks cells across requests and reports progress; file.create only on first chunk", async () => {
    // 3500 cells > CHUNK(1500) → 3 requests (1500 + 1500 + 500).
    const cells = makeCells(3500)
    const bodies: Array<{ cells: unknown[]; file?: unknown }> = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 })
    }) as unknown as typeof fetch

    const progress: number[] = []
    await bulkUploadSource({
      projectId: "p",
      fileId: "f",
      file,
      cells,
      getToken,
      onProgress: (uploaded) => progress.push(uploaded),
      fetchImpl,
    })

    expect(bodies).toHaveLength(3)
    expect(bodies[0].cells).toHaveLength(1500)
    expect(bodies[1].cells).toHaveLength(1500)
    expect(bodies[2].cells).toHaveLength(500)
    // file.create rides only the first chunk.
    expect(bodies[0].file).toBeTruthy()
    expect(bodies[1].file).toBeUndefined()
    expect(progress).toEqual([1500, 3000, 3500])
  })

  it("throws a clear error when no token is available", async () => {
    await expect(
      bulkUploadSource({
        projectId: "p",
        fileId: "f",
        file,
        cells: makeCells(1),
        getToken: async () => null,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/signed out|token/i)
  })

  it("throws on a non-OK server response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("role too low", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(
      bulkUploadSource({ projectId: "p", fileId: "f", file, cells: makeCells(2), getToken, fetchImpl }),
    ).rejects.toThrow(/HTTP 403/)
  })

  it("sends one request (with file.create) even for a zero-cell file", async () => {
    const bodies: unknown[] = []
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    await bulkUploadSource({ projectId: "p", fileId: "f", file, cells: [], getToken, fetchImpl })
    expect(bodies).toHaveLength(1)
  })
})
