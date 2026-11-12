import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  IMPORT_SESSION_MAX_AGE_MS,
  completeImportSession,
  importCellFingerprint,
  listResumableImportSessions,
  recordLandedChunk,
  recordOriginalUploaded,
  releaseImportSession,
  resetImportSessionConnectionForTests,
  resolveImportSession,
} from "./import-session"

async function wipe(): Promise<void> {
  await resetImportSessionConnectionForTests()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("aquilla-import-sessions")
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

const seed = {
  projectId: "p1",
  importKey: "usfm:JON:jonah.usfm",
  fileName: "jonah.usfm",
  cellKeys: ["a", "b", "c"],
  chunkSize: 1500,
}

/**
 * Resolve a session and hand the claim straight back, the way an import run
 * does when it ends. Throws if something else already held the key, which no
 * test here should.
 */
async function claimed(args: typeof seed = seed) {
  const session = await resolveImportSession(args)
  if (!session) throw new Error("expected to own the import session")
  releaseImportSession(session.key)
  return session
}

describe("importCellFingerprint", () => {
  it("is stable for the same keys in the same order", () => {
    expect(importCellFingerprint(["a", "b"])).toBe(importCellFingerprint(["a", "b"]))
  })

  it("changes when a re-parse produces different cell keys", () => {
    expect(importCellFingerprint(["a", "b"])).not.toBe(importCellFingerprint(["x", "y"]))
  })

  it("changes when the order changes, and when a prefix is compared with the whole", () => {
    expect(importCellFingerprint(["a", "b"])).not.toBe(importCellFingerprint(["b", "a"]))
    expect(importCellFingerprint(["a"])).not.toBe(importCellFingerprint(["a", "b"]))
  })
})

describe("resolveImportSession", () => {
  beforeEach(wipe)
  afterEach(async () => {
    vi.restoreAllMocks()
    await wipe()
  })

  it("mints a full set of ids for a first attempt", async () => {
    const session = await claimed()
    expect(session.landedOffsets).toEqual([])
    expect(session.originalUploaded).toBe(false)
    expect(session.totalCells).toBe(3)
    const ids = [
      session.fileId,
      session.fileEventId,
      session.stageEventId,
      session.publishEventId,
      session.artifactId,
    ]
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(5)
  })

  it("resumes the same file and ids when a retry re-sends the same cells", async () => {
    const first = await claimed()
    await recordLandedChunk(first.key, 0)
    await recordOriginalUploaded(first.key)

    const retry = await claimed()
    expect(retry.fileId).toBe(first.fileId)
    expect(retry.fileEventId).toBe(first.fileEventId)
    expect(retry.stageEventId).toBe(first.stageEventId)
    expect(retry.publishEventId).toBe(first.publishEventId)
    expect(retry.artifactId).toBe(first.artifactId)
    expect(retry.landedOffsets).toEqual([0])
    expect(retry.originalUploaded).toBe(true)
  })

  it("records landed chunks in ascending order and never twice", async () => {
    const session = await claimed()
    await recordLandedChunk(session.key, 3000)
    await recordLandedChunk(session.key, 0)
    await recordLandedChunk(session.key, 3000)
    await recordLandedChunk(session.key, 1500)
    expect((await claimed()).landedOffsets).toEqual([0, 1500, 3000])
  })

  it("starts a new file when a re-parse produced different cells", async () => {
    const first = await claimed()
    await recordLandedChunk(first.key, 0)

    // Chunking different cells into the first attempt's file would duplicate
    // rows, so the mismatched session is replaced outright.
    const reparsed = await claimed({ ...seed, cellKeys: ["x", "y", "z"] })
    expect(reparsed.fileId).not.toBe(first.fileId)
    expect(reparsed.landedOffsets).toEqual([])
    expect(reparsed.originalUploaded).toBe(false)
  })

  it("starts a new file when the chunking changed under a recorded run", async () => {
    const first = await claimed()
    await recordLandedChunk(first.key, 1500)
    const rechunked = await claimed({ ...seed, chunkSize: 500 })
    expect(rechunked.fileId).not.toBe(first.fileId)
    expect(rechunked.landedOffsets).toEqual([])
  })

  it("keeps one session per file, and per project", async () => {
    const jonah = await claimed()
    const amos = await claimed({ ...seed, importKey: "usfm:AMO:amos.usfm", fileName: "amos.usfm" })
    const otherProject = await claimed({ ...seed, projectId: "p2" })
    expect(new Set([jonah.fileId, amos.fileId, otherProject.fileId]).size).toBe(3)

    expect((await listResumableImportSessions("p1")).map((s) => s.importKey).sort())
      .toEqual(["usfm:AMO:amos.usfm", "usfm:JON:jonah.usfm"])
    expect((await listResumableImportSessions("p2")).map((s) => s.projectId)).toEqual(["p2"])
  })

  it("forgets a completed import, so importing the same file again starts clean", async () => {
    const first = await claimed()
    await recordLandedChunk(first.key, 0)
    await completeImportSession(first.key)

    expect(await listResumableImportSessions("p1")).toEqual([])
    const again = await claimed()
    expect(again.fileId).not.toBe(first.fileId)
    expect(again.landedOffsets).toEqual([])
  })

  it("sweeps a session nobody came back to, and does not resume it", async () => {
    const stale = await claimed()
    await recordLandedChunk(stale.key, 0)

    // Only the clock moves — fake timers would also stall IndexedDB's own.
    const real = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(real + IMPORT_SESSION_MAX_AGE_MS + 1)
    const fresh = await claimed()
    expect(fresh.fileId).not.toBe(stale.fileId)
    expect(fresh.landedOffsets).toEqual([])
    expect(await listResumableImportSessions("p1")).toHaveLength(1)
  })

  it("refuses a second concurrent run on the same file, rather than sharing its file", async () => {
    const running = await resolveImportSession(seed)
    expect(running).not.toBeNull()
    // Two files dropped together under one name: the second must import on its
    // own rather than chunk into the first one's file.
    expect(await resolveImportSession(seed)).toBeNull()

    releaseImportSession(running!.key)
    const afterwards = await resolveImportSession(seed)
    expect(afterwards?.fileId).toBe(running!.fileId)
  })

  it("notes nothing for a session that is already gone", async () => {
    const session = await claimed()
    await completeImportSession(session.key)
    await expect(recordLandedChunk(session.key, 0)).resolves.toBeUndefined()
    await expect(recordOriginalUploaded(session.key)).resolves.toBeUndefined()
    expect(await listResumableImportSessions("p1")).toEqual([])
  })
})
