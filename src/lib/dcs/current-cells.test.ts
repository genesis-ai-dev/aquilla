// buildCurrentCells (AQU-1860) — the DCS delta baseline.
//
// The behaviour under guard is that the per-file reads overlap: a 66-book
// adapter used to pay 66 serial round trips here before any delta work could
// start. The result must still be identical to the old sequential fold.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildCurrentCells, DCS_CELL_READ_CONCURRENCY } from "./current-cells"
import { contentHash } from "./content-hash"

const mockFetchProjectFiles = vi.fn()
const mockFetchAllFileCells = vi.fn()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: (...a: unknown[]) => mockFetchProjectFiles(...a),
  fetchAllFileCells: (...a: unknown[]) => mockFetchAllFileCells(...a),
}))

const getToken = vi.fn(async (fileId: string): Promise<string | null> => `tok-${fileId}`)

function args(overrides: Partial<Parameters<typeof buildCurrentCells>[0]> = {}) {
  return {
    projectId: "adapter-1",
    getToken,
    tokenErrorMessage: "no token",
    ...overrides,
  }
}

beforeEach(() => {
  getToken.mockClear().mockImplementation(async (fileId: string) => `tok-${fileId}`)
  mockFetchProjectFiles.mockReset()
  mockFetchAllFileCells.mockReset()
})

describe("buildCurrentCells", () => {
  it("keys every file's source rows by cellId, hashed with the shared djb2", async () => {
    mockFetchProjectFiles.mockResolvedValue([
      { fileId: "file-tit", name: "TIT" },
      { fileId: "file-phm", name: "PHM" },
    ])
    mockFetchAllFileCells.mockImplementation(async (_p, fileId: string) =>
      fileId === "file-tit"
        ? [{ cellId: "TIT-1-1", value: "grace", eventId: "ev-tit-1" }]
        : [{ cellId: "PHM-1-1", value: "peace", eventId: "ev-phm-1" }],
    )

    const current = await buildCurrentCells(args())

    expect(current.size).toBe(2)
    expect(current.get("TIT-1-1")).toEqual({
      eventId: "ev-tit-1",
      contentHash: contentHash("grace"),
      fileId: "file-tit",
    })
    expect(current.get("PHM-1-1")).toEqual({
      eventId: "ev-phm-1",
      contentHash: contentHash("peace"),
      fileId: "file-phm",
    })
    // source lane only — a target row must never become a delta baseline.
    for (const call of mockFetchAllFileCells.mock.calls) expect(call[3]).toBe("source")
  })

  it("overlaps the per-file reads up to the concurrency cap", async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      fileId: `file-${i}`,
      name: `F${i}`,
    }))
    mockFetchProjectFiles.mockResolvedValue(files)

    let inFlight = 0
    let peak = 0
    const releases: Array<() => void> = []
    mockFetchAllFileCells.mockImplementation(async (_p, fileId: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => releases.push(resolve))
      inFlight -= 1
      return [{ cellId: `${fileId}-c1`, value: "v", eventId: `ev-${fileId}` }]
    })

    const pending = buildCurrentCells(args())
    // Drain: each release lets one worker pick up the next file.
    for (let i = 0; i < files.length + DCS_CELL_READ_CONCURRENCY; i++) {
      await Promise.resolve()
      releases.shift()?.()
      await Promise.resolve()
    }
    const current = await pending

    expect(current.size).toBe(files.length)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(DCS_CELL_READ_CONCURRENCY)
  })

  it("folds results in file order, so a duplicated cellId resolves as it did serially", async () => {
    // Two files reporting the same cellId is pathological, but the fold order
    // decides which wins. Parallel reads must not make that nondeterministic.
    mockFetchProjectFiles.mockResolvedValue([
      { fileId: "file-first", name: "A" },
      { fileId: "file-second", name: "B" },
    ])
    mockFetchAllFileCells.mockImplementation(async (_p, fileId: string) => {
      // The FIRST file is deliberately the slower read.
      if (fileId === "file-first") {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return [{ cellId: "DUP", value: "from-first", eventId: "ev-first" }]
      }
      return [{ cellId: "DUP", value: "from-second", eventId: "ev-second" }]
    })

    const current = await buildCurrentCells(args())
    expect(current.get("DUP")).toMatchObject({ fileId: "file-second" })
  })

  it("throws the caller's message when no project token can be minted", async () => {
    getToken.mockResolvedValue(null)
    await expect(
      buildCurrentCells(args({ tokenErrorMessage: "could not mint" })),
    ).rejects.toThrow("could not mint")
    expect(mockFetchProjectFiles).not.toHaveBeenCalled()
  })

  it("falls back to the project token when a per-file mint misses", async () => {
    mockFetchProjectFiles.mockResolvedValue([{ fileId: "file-tit", name: "TIT" }])
    mockFetchAllFileCells.mockResolvedValue([])
    getToken.mockImplementation(async (fileId: string) =>
      fileId === "file-tit" ? null : "project-token",
    )

    await buildCurrentCells(args())
    expect(mockFetchAllFileCells).toHaveBeenCalledWith(
      "adapter-1",
      "file-tit",
      "project-token",
      "source",
    )
  })

  it("propagates a read failure rather than returning a partial baseline", async () => {
    // A partial baseline is the dangerous outcome: every unread cell looks
    // absent, and classifyAgainstCurrent would call it a create.
    mockFetchProjectFiles.mockResolvedValue([
      { fileId: "file-a", name: "A" },
      { fileId: "file-b", name: "B" },
    ])
    mockFetchAllFileCells.mockImplementation(async (_p, fileId: string) => {
      if (fileId === "file-b") throw new Error("read failed")
      return [{ cellId: "A-1", value: "v", eventId: "ev-a" }]
    })
    await expect(buildCurrentCells(args())).rejects.toThrow("read failed")
  })
})
