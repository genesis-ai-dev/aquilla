/**
 * AQU-1859: a bulk import that fails half-way is resumed into the SAME file,
 * re-sending only the chunks that never landed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { bulkUploadSource, BULK_IMPORT_CHUNK, type BulkImportCell } from "./bulk-import"
import {
  listResumableImportSessions,
  resetImportSessionConnectionForTests,
  resolveImportSession,
} from "./import-session"

vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example",
}))
vi.mock("./source-upload", () => ({
  assertSourceUploadSize: vi.fn(),
  uploadSourceOriginal: vi.fn().mockResolvedValue({ artifactId: "a1", key: "k", sha256: "d" }),
}))

function makeCells(count: number): BulkImportCell[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    cellId: `cell-${i}`,
    anchorCellId: i === 0 ? null : `cell-${i - 1}`,
    value: `verse ${i}`,
  }))
}

interface Posted {
  fileId: string
  file?: { id: string }
  cells: BulkImportCell[]
  complete?: boolean
  publishEventId?: string
  stageEventId?: string
}

/** Collects every /import body, failing the chunks whose offset is listed. */
function recordingFetch(failAtFirstCellId: string[] = []) {
  const bodies: Posted[] = []
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted
    bodies.push(body)
    if (body.cells.length > 0 && failAtFirstCellId.includes(body.cells[0].id)) {
      throw new Error("network down")
    }
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  return { bodies, fetchImpl }
}

const seed = (cells: BulkImportCell[]) => ({
  projectId: "p1",
  importKey: "usfm:JON:jonah.usfm",
  fileName: "jonah.usfm",
  cellKeys: cells.map((cell) => cell.cellId),
  chunkSize: BULK_IMPORT_CHUNK,
})

/** A resolve that must have produced a session (nothing else holds the key). */
async function claim(cells: BulkImportCell[]) {
  const session = await resolveImportSession(seed(cells))
  if (!session) throw new Error("expected to own the import session")
  return session
}

async function wipe(): Promise<void> {
  await resetImportSessionConnectionForTests()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("aquilla-import-sessions")
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

describe("bulkUploadSource with a resumable session", () => {
  beforeEach(wipe)
  afterEach(async () => {
    vi.clearAllMocks()
    await wipe()
  })

  it("re-sends only the failed chunk, into the file the first attempt created", async () => {
    const cells = makeCells(BULK_IMPORT_CHUNK * 2 + 10)
    const first = await claim(cells)

    const attempt1 = recordingFetch(["evt-1500"])
    await expect(bulkUploadSource({
      projectId: "p1",
      fileId: first.fileId,
      file: { id: first.fileEventId, name: "jonah.usfm" },
      cells,
      session: first,
      getToken: async () => "tok",
      fetchImpl: attempt1.fetchImpl,
    })).rejects.toThrow(/network down/)

    // The failed run still finalized what landed, but did NOT publish.
    const finalize1 = attempt1.bodies.filter((b) => b.complete)
    expect(finalize1).toHaveLength(1)
    expect(finalize1[0].publishEventId).toBeUndefined()

    // ... and the session survives, holding the resume point.
    const resumed = await claim(cells)
    expect(resumed.fileId).toBe(first.fileId)
    expect(resumed.landedOffsets).toEqual([0, 3000])

    const attempt2 = recordingFetch()
    const progress: number[] = []
    await bulkUploadSource({
      projectId: "p1",
      fileId: resumed.fileId,
      file: { id: resumed.fileEventId, name: "jonah.usfm" },
      cells,
      session: resumed,
      getToken: async () => "tok",
      onProgress: (uploaded) => progress.push(uploaded),
      fetchImpl: attempt2.fetchImpl,
    })

    const chunks2 = attempt2.bodies.filter((b) => !b.complete)
    expect(chunks2).toHaveLength(1)
    expect(chunks2[0].cells[0].id).toBe("evt-1500")
    expect(chunks2[0].fileId).toBe(first.fileId)
    // file.create landed on the first attempt; re-sending it is the duplicate
    // the resume exists to avoid.
    expect(chunks2.every((b) => b.file === undefined)).toBe(true)

    // Every cell is accounted for, skipped chunks included, so the progress UI
    // does not restart from zero.
    expect(progress.at(-1)).toBe(cells.length)

    // The second run completes the import: it publishes with the session's own
    // reveal receipt, and the session is forgotten.
    const finalize2 = attempt2.bodies.filter((b) => b.complete)
    expect(finalize2).toHaveLength(1)
    expect(finalize2[0].publishEventId).toBe(first.publishEventId)
    expect(await listResumableImportSessions("p1")).toEqual([])
  })

  it("uses the session's staging and artifact ids rather than minting new ones", async () => {
    const cells = makeCells(2)
    const session = await claim(cells)
    const { bodies, fetchImpl } = recordingFetch()
    await bulkUploadSource({
      projectId: "p1",
      fileId: session.fileId,
      file: { id: session.fileEventId, name: "jonah.usfm" },
      cells,
      session,
      deferPublication: true,
      getToken: async () => "tok",
      fetchImpl,
    })
    expect(bodies[0].stageEventId).toBe(session.stageEventId)
  })

  it("preserves the original once, not again on the retry", async () => {
    const sourceUpload = await import("./source-upload")
    const cells = makeCells(BULK_IMPORT_CHUNK + 1)
    const first = await claim(cells)

    const attempt1 = recordingFetch(["evt-1500"])
    await expect(bulkUploadSource({
      projectId: "p1",
      fileId: first.fileId,
      file: { id: first.fileEventId, name: "jonah.usfm" },
      cells,
      rawSource: "\\id JON",
      rawSourceFormat: "usfm",
      session: first,
      getToken: async () => "tok",
      fetchImpl: attempt1.fetchImpl,
    })).rejects.toThrow(/network down/)
    expect(sourceUpload.uploadSourceOriginal).toHaveBeenCalledTimes(1)

    const resumed = await claim(cells)
    expect(resumed.originalUploaded).toBe(true)
    const attempt2 = recordingFetch()
    await bulkUploadSource({
      projectId: "p1",
      fileId: resumed.fileId,
      file: { id: resumed.fileEventId, name: "jonah.usfm" },
      cells,
      rawSource: "\\id JON",
      rawSourceFormat: "usfm",
      session: resumed,
      getToken: async () => "tok",
      fetchImpl: attempt2.fetchImpl,
    })
    expect(sourceUpload.uploadSourceOriginal).toHaveBeenCalledTimes(1)
  })

  it("sends every chunk when there is no session (unchanged one-shot path)", async () => {
    const cells = makeCells(BULK_IMPORT_CHUNK + 1)
    const { bodies, fetchImpl } = recordingFetch()
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "jonah.usfm" },
      cells,
      getToken: async () => "tok",
      fetchImpl,
    })
    expect(bodies.filter((b) => !b.complete)).toHaveLength(2)
    expect(await listResumableImportSessions("p1")).toEqual([])
  })
})
