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

  it("stores a multi-book USFM bundle once and publishes books only after every binding lands", async () => {
    const requests: Array<{ url: string; body: unknown; headers: HeadersInit | undefined }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const isBinary = init?.body instanceof ArrayBuffer
      const body = isBinary ? init?.body : JSON.parse(String(init?.body))
      requests.push({ url, body, headers: init?.headers })
      return new Response(JSON.stringify({ accepted: 1, artifactId: "artifact", key: "key", sha256: "a".repeat(64) }), { status: 200 })
    }))
    const bundle = "\\id GEN\n\\c 1\n\\v 1 In the beginning.\n\\id EXO\n\\c 1\n\\v 1 These are the names.\n"

    const result = await importFile(
      new File([bundle], "bundle.usfm", { type: "text/plain" }),
      { projectId: "p-bundle", author: "alice", getToken },
    )

    expect(result.refs).toHaveLength(2)
    const sourceUploads = requests.filter((request) => request.url.endsWith("/source"))
    expect(sourceUploads).toHaveLength(3)
    const supportUpload = sourceUploads.find((request) =>
      (request.headers as Record<string, string>)["X-Artifact-Binding-Role"] === "support")
    expect(new TextDecoder().decode(supportUpload?.body as ArrayBuffer)).toBe(bundle)
    const publishIndexes = requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.body && typeof request.body === "object" && "publishEventId" in (request.body as object))
      .map(({ index }) => index)
    expect(publishIndexes).toHaveLength(2)
    expect(Math.min(...publishIndexes)).toBeGreaterThan(requests.indexOf(supportUpload!))
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

// AQU-638: a bilingual import (source + mapped target column) must land the
// target text, not just the source. buildBulkCellsWithSpeakers only seeds the
// source side, so emitParsedFile has to emit target.cell.commit events for any
// parsed string carrying `translated`. Source cells go over the mocked fetch
// (bulk /import); target commits are ENQUEUED to the CQRS outbox, so we assert
// against the outbox rather than the captured HTTP bodies.
describe("import — bilingual target text (AQU-638)", () => {
  beforeEach(async () => {
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  function bilingual(id: string, original: string, translated: string, group: string): TranslatableString {
    return { id, original, translated, context: group, group, type: "text" }
  }

  it("emits target.cell.commit for each row with a mapped target, chained on its source cell", async () => {
    const { ref } = await emitParsedFile(
      {
        name: "hungarian.csv",
        strings: [
          bilingual("row-1", "Title", "Templom", "Title"),
          bilingual("row-2", "Scene one", "Első jelenet", "Row 2"),
          // Source-only row: no target column value → no target commit.
          bilingual("row-3", "Untranslated", "", "Row 3"),
        ],
      },
      "csv",
      { projectId: "p-bi", author: "alice", sourceLanguage: "eng", targetLanguage: "hun", getToken },
    )

    const rows = await peekOutboxBatch(100)
    const commits = rows.filter((r) => r.event.kind === "target.cell.commit")
    // Two rows carried target text; the empty one must NOT produce a commit.
    expect(commits).toHaveLength(2)

    const byCell = new Map(commits.map((c) => [c.event.cellId, c.event]))
    const first = byCell.get("row-1")!
    expect(first).toBeDefined()
    expect(first.fileId).toBe(ref.id)
    expect((first.payload as { value: string }).value).toBe("Templom")
    // parentId pins the target to its own source cell's event id (AD-9).
    expect(first.parentId).toBeTruthy()
    expect((first.payload as { sourceEventId: string }).sourceEventId).toBe(first.parentId)

    expect((byCell.get("row-2")!.payload as { value: string }).value).toBe("Első jelenet")
    expect(byCell.has("row-3")).toBe(false)
  })

  it("emits no target commits when no row carries target text (no false fill)", async () => {
    await emitParsedFile(
      {
        name: "monolingual.csv",
        strings: [
          bilingual("row-1", "Alpha", "", "Row 1"),
          bilingual("row-2", "Beta", "", "Row 2"),
        ],
      },
      "csv",
      { projectId: "p-mono", author: "alice", getToken },
    )

    const rows = await peekOutboxBatch(100)
    expect(rows.filter((r) => r.event.kind === "target.cell.commit")).toHaveLength(0)
  })
})
