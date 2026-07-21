// Source import emits file.create + N chained source.cell.create and streams
// them to the server's bulk endpoint (POST /import). These tests mock fetch
// and assert the request shape (file metadata + anchor-chain order).

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import "fake-indexeddb/auto"
import { importFile, emitParsedFile } from "./import"
import type { TranslatableString } from "./parsers/types"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./sync/outbox"

interface CapturedBody {
  projectId: string
  fileId: string
  file?: { name: string; role?: string; kind?: string }
  cells: Array<{ id: string; cellId: string; anchorCellId: string | null; value: string }>
  targets?: Array<{ id: string; cellId: string; parentId: string; value: string; targetLang?: string }>
  complete?: boolean
}

let captured: CapturedBody[]

beforeEach(async () => {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    request.onblocked = () => resolve()
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
  captured = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body instanceof ArrayBuffer) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body)) as CapturedBody
      captured.push(body)
      return new Response(JSON.stringify({ accepted: body.cells.length, fileId: body.fileId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }),
  )
})

afterEach(async () => {
  await resetOutboxConnectionForTests()
  vi.unstubAllGlobals()
})

function makeString(id: string, original: string, group: string): TranslatableString {
  return { id, original, translated: "", context: "", group, type: "verse" }
}

const getToken = async () => "test-token"

describe("import — bulk upload", () => {
  it("uploads file.create + N source.cell.create with anchor-chain order", async () => {
    const { ref } = await emitParsedFile(
      {
        name: "GEN",
        strings: [
          makeString("GEN 1:1", "In the beginning…", "GEN 1"),
          makeString("GEN 1:2", "And the earth was…", "GEN 1"),
          makeString("GEN 1:3", "And God said…", "GEN 1"),
        ],
      },
      "usfm",
      { projectId: "p-1", author: "alice", sourceLanguage: "heb", targetLanguage: "eng", getToken },
    )

    expect(ref.cellCount).toBe(3)
    // 3 cells < one chunk → a single cell-carrying request, followed by the
    // required empty finalize request (counter/progress rebuild).
    expect(captured).toHaveLength(2)
    expect(captured[1].complete).toBe(true)
    expect(captured[1].cells).toHaveLength(0)
    const body = captured[0]
    expect(body.projectId).toBe("p-1")
    expect(body.fileId).toBe(ref.id)

    // First (only) chunk carries file.create metadata.
    expect(body.file?.name).toBe("GEN")
    expect(body.file?.role).toBe("source")
    expect(body.file?.kind).toBe("usfm")

    // Cells: parser ids preserved, chained by anchorCellId.
    expect(body.cells.map((c) => c.cellId)).toEqual(["GEN 1:1", "GEN 1:2", "GEN 1:3"])
    expect(body.cells.map((c) => c.anchorCellId)).toEqual([null, "GEN 1:1", "GEN 1:2"])
    expect(body.cells[0].value).toBe("In the beginning…")
  })

  it("importFile dispatches on extension and uploads cells", async () => {
    const file = new File([new Blob(["alpha\nbeta\ngamma\n"])], "notes.txt", { type: "text/plain" })
    const { refs } = await importFile(file, { projectId: "p-7", author: "carol", getToken })

    expect(refs).toHaveLength(1)
    expect(refs[0].cellCount).toBeGreaterThan(0)
    // One cell-carrying chunk + the trailing finalize request.
    expect(captured).toHaveLength(2)
    expect(captured[1].complete).toBe(true)
    expect(captured[0].file?.name).toBe("notes.txt")
    expect(captured[0].cells.length).toBe(refs[0].cellCount)
  })

  it("publishes bilingual target values atomically in the selected lane against the paired source cells", async () => {
    await emitParsedFile(
      {
        name: "memory.xlf",
        strings: [
          { id: "unit-1", original: "Hello", translated: "Bonjour", context: "1", group: "1", type: "text" },
          { id: "unit-2", original: "World", translated: "", context: "2", group: "2", type: "text" },
        ],
      },
      "xliff",
      { projectId: "p-lanes", author: "alice", targetLang: "fr-CA", getToken },
    )

    const sourceCell = captured[0].cells[0]
    expect(captured[0].targets).toEqual([expect.objectContaining({
      cellId: sourceCell.cellId,
      parentId: sourceCell.id,
      value: "Bonjour",
      targetLang: "fr-CA",
    })])
    expect(await peekOutboxBatch(100)).toHaveLength(0)
    expect(captured.at(-1)).toMatchObject({ complete: true, cells: [] })
  })
})
