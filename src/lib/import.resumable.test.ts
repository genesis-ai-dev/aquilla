/**
 * AQU-1859: an import interrupted half-way is retried into the SAME file.
 *
 * `emitParsedFile` re-parses on a retry, so these tests drive it twice — the
 * way the Import dialog's "try again" does — and assert that the second run
 * continues the first run's file instead of creating a second one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import "fake-indexeddb/auto"
import { emitParsedFile } from "./import"
import type { TranslatableString } from "./parsers/types"
import { resetImportSessionConnectionForTests } from "./sync/import-session"

interface CapturedBody {
  fileId: string
  file?: { id: string; name: string }
  cells: { id: string; cellId: string }[]
  targets?: { id: string; parentId: string }[]
  complete?: boolean
  publishEventId?: string
  stageEventId?: string
}

let captured: CapturedBody[]
/** Cell ids whose chunk the stubbed server refuses. */
let refuse: Set<string>

beforeEach(async () => {
  await resetImportSessionConnectionForTests()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("aquilla-import-sessions")
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
  captured = []
  refuse = new Set()
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.body instanceof ArrayBuffer) return new Response("{}", { status: 200 })
    const body = JSON.parse(String(init?.body)) as CapturedBody
    captured.push(body)
    if (body.cells.some((cell) => refuse.has(cell.cellId))) {
      return new Response("chunk refused", { status: 503 })
    }
    return new Response(JSON.stringify({ accepted: body.cells.length }), { status: 200 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const ctx = { projectId: "p1", author: "u1", getToken: async () => "tok" }

/** Keyed verses — the shape every scripture parser produces. */
function verses(count: number): TranslatableString[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `JON 1:${i + 1}`,
    original: `verse ${i + 1}`,
    translated: "",
    context: "",
    group: "JON 1",
    type: "verse",
  }))
}

const parsed = (strings: TranslatableString[]) => ({ name: "jonah.usfm", strings })

describe("AQU-1859 — resumable source import", () => {
  it("retries into the same file, with the same ids, after a refused chunk", async () => {
    const strings = verses(3)
    refuse.add("JON 1:1")

    await expect(emitParsedFile(parsed(strings), "usfm" as never, ctx)).rejects.toThrow()
    // One chunk, retried the route's three times before the run gives up.
    const firstAttempt = captured.filter((body) => body.cells.length > 0)
    expect(firstAttempt).toHaveLength(3)
    expect(new Set(firstAttempt.map((body) => body.fileId)).size).toBe(1)
    const fileId = firstAttempt[0].fileId
    const fileEventId = firstAttempt[0].file?.id
    const stageEventId = firstAttempt[0].stageEventId
    const cellEventIds = firstAttempt[0].cells.map((cell) => cell.id)

    captured = []
    refuse.clear()
    const result = await emitParsedFile(parsed(verses(3)), "usfm" as never, ctx)

    // ONE file: the retry neither minted a new file id nor a new file.create.
    expect(result.ref.id).toBe(fileId)
    const retry = captured.filter((body) => body.cells.length > 0)
    expect(retry).toHaveLength(1)
    expect(retry[0].fileId).toBe(fileId)
    expect(retry[0].file?.id).toBe(fileEventId)
    expect(retry[0].stageEventId).toBe(stageEventId)

    // No duplicate cells: the re-sent chunk replays the same event ids, which
    // the import route's INSERT OR IGNORE collapses onto the existing rows.
    expect(retry[0].cells.map((cell) => cell.id)).toEqual(cellEventIds)
    expect(new Set(cellEventIds).size).toBe(3)
  })

  it("does not re-send chunks the first attempt landed", async () => {
    // 1500 cells per chunk, so 1600 verses is two chunks: fail only the second.
    const strings = verses(1600)
    refuse.add("JON 1:1501")

    await expect(emitParsedFile(parsed(strings), "usfm" as never, ctx)).rejects.toThrow()
    const landed = captured.filter((b) => b.cells.length > 0 && !refuse.has(b.cells[0].cellId))
    expect(landed).toHaveLength(1)

    captured = []
    refuse.clear()
    await emitParsedFile(parsed(verses(1600)), "usfm" as never, ctx)

    const resent = captured.filter((body) => body.cells.length > 0)
    expect(resent).toHaveLength(1)
    expect(resent[0].cells[0].cellId).toBe("JON 1:1501")
    // The finalize publishes the file the first attempt staged.
    expect(captured.filter((b) => b.complete && b.publishEventId)).toHaveLength(1)
  })

  it("starts a clean file when the same source is imported again after success", async () => {
    const first = await emitParsedFile(parsed(verses(2)), "usfm" as never, ctx)
    captured = []
    const second = await emitParsedFile(parsed(verses(2)), "usfm" as never, ctx)
    expect(second.ref.id).not.toBe(first.ref.id)
    expect(captured.filter((b) => b.cells.length > 0)).toHaveLength(1)
  })

  it("starts a clean file when a retry's parse produced different cells", async () => {
    refuse.add("JON 1:1")
    await expect(emitParsedFile(parsed(verses(3)), "usfm" as never, ctx)).rejects.toThrow()
    const abandoned = captured.filter((b) => b.cells.length > 0)[0].fileId

    captured = []
    refuse.clear()
    // A different source behind the same name: chunking these into the first
    // attempt's file would duplicate its rows.
    const result = await emitParsedFile(parsed(verses(5)), "usfm" as never, ctx)
    expect(result.ref.id).not.toBe(abandoned)
    expect(captured.filter((b) => b.cells.length > 0)[0].file).toBeDefined()
  })

  it("keeps target rows chained to the source events they are imported with", async () => {
    const strings = verses(2).map((string) => ({ ...string, translated: `drafted ${string.id}` }))
    refuse.add("JON 1:1")
    await expect(emitParsedFile(parsed(strings), "usfm" as never, ctx)).rejects.toThrow()
    const first = captured.filter((b) => b.cells.length > 0)[0]

    captured = []
    refuse.clear()
    const retryStrings = verses(2).map((string) => ({ ...string, translated: `drafted ${string.id}` }))
    await emitParsedFile(parsed(retryStrings), "usfm" as never, ctx)
    const retry = captured.filter((b) => b.cells.length > 0)[0]

    expect(retry.targets?.map((t) => t.id)).toEqual(first.targets?.map((t) => t.id))
    expect(retry.targets?.map((t) => t.parentId)).toEqual(retry.cells.map((c) => c.id))
    // A target commit must never collide with the source event it chains onto.
    const ids = [...retry.cells.map((c) => c.id), ...(retry.targets ?? []).map((t) => t.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
