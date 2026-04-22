import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { projectDoc, diffProjection, cellFingerprint } from "../projection"

// Builds a Y.Doc matching the shape the codex-web-app writes (see
// codex-web-app/src/lib/store/file-doc.ts). Only the fields exercised by
// projection are populated — tests avoid over-specifying the schema.
function makeDoc(
  init: (ctx: {
    meta: Y.Map<unknown>
    cells: Y.Map<Y.Map<unknown>>
  }) => void
): Y.Doc {
  const doc = new Y.Doc()
  const meta = doc.getMap("meta")
  const cells = doc.getMap<Y.Map<unknown>>("cells")
  doc.transact(() => init({ meta, cells }))
  return doc
}

function addCell(
  cells: Y.Map<Y.Map<unknown>>,
  id: string,
  fields: {
    text?: string
    history?: Array<{ timestamp: string; author?: string; validated?: boolean }>
  }
): void {
  const cell = new Y.Map<unknown>()
  if (typeof fields.text === "string") {
    const frag = new Y.XmlFragment()
    const p = new Y.XmlElement("paragraph")
    const t = new Y.XmlText()
    t.insert(0, fields.text)
    p.insert(0, [t])
    frag.insert(0, [p])
    cell.set("translatedXml", frag)
  }
  if (fields.history) {
    const hist = new Y.Array<unknown>()
    hist.push(fields.history)
    cell.set("history", hist)
  }
  cells.set(id, cell)
}

describe("projectDoc", () => {
  it("returns empty cells + zero counters for an empty doc", () => {
    const doc = makeDoc(() => {})
    const result = projectDoc("proj-1", "file-a", doc)
    expect(result.cells).toEqual([])
    expect(result.file).toMatchObject({
      fileId: "file-a",
      projectId: "proj-1",
      cellCount: 0,
      approvedCount: 0,
      wordCount: 0,
      lastEditAt: null,
    })
    doc.destroy()
  })

  it("extracts plain text from a translated XmlFragment and counts words", () => {
    const doc = makeDoc(({ cells }) => {
      addCell(cells, "cell-1", { text: "Genesis chapter one verse one" })
    })
    const result = projectDoc("proj-1", "file-a", doc)
    expect(result.cells).toHaveLength(1)
    const c = result.cells[0]
    expect(c.cellId).toBe("cell-1")
    expect(c.contentText).toBe("Genesis chapter one verse one")
    expect(c.wordCount).toBe(5)
    expect(c.contentHash).toMatch(/^[0-9a-f]{8}$/)
    doc.destroy()
  })

  it("uses the most recent history entry for lastEditor / lastEditAt", () => {
    const doc = makeDoc(({ cells }) => {
      addCell(cells, "cell-1", {
        text: "hola",
        history: [
          { timestamp: "2026-04-01T00:00:00Z", author: "alice", validated: false },
          { timestamp: "2026-04-10T12:00:00Z", author: "bob", validated: false },
          { timestamp: "2026-04-02T00:00:00Z", author: "carol", validated: false },
        ],
      })
    })
    const result = projectDoc("proj-1", "file-a", doc)
    expect(result.cells[0].lastEditor).toBe("bob")
    expect(result.cells[0].lastEditAt).toBe(Date.parse("2026-04-10T12:00:00Z"))
    doc.destroy()
  })

  it("marks a cell validated if any history entry has validated=true", () => {
    const doc = makeDoc(({ cells }) => {
      addCell(cells, "cell-1", {
        text: "approved content",
        history: [
          { timestamp: "2026-04-01T00:00:00Z", author: "alice", validated: false },
          { timestamp: "2026-04-05T00:00:00Z", author: "bob", validated: true },
        ],
      })
      addCell(cells, "cell-2", {
        text: "unapproved",
        history: [{ timestamp: "2026-04-01T00:00:00Z", author: "alice", validated: false }],
      })
    })
    const result = projectDoc("proj-1", "file-a", doc)
    const c1 = result.cells.find((c) => c.cellId === "cell-1")!
    const c2 = result.cells.find((c) => c.cellId === "cell-2")!
    expect(c1.validated).toBe(1)
    expect(c2.validated).toBe(0)
    expect(result.file.approvedCount).toBe(1)
    doc.destroy()
  })

  it("rolls up file-level counters correctly", () => {
    const doc = makeDoc(({ meta, cells }) => {
      meta.set("fileName", "Genesis.codex")
      meta.set("fileType", "codex")
      meta.set("sourceLanguage", "en")
      meta.set("targetLanguage", "fr")
      addCell(cells, "cell-1", {
        text: "two words",
        history: [{ timestamp: "2026-04-05T00:00:00Z", author: "a", validated: true }],
      })
      addCell(cells, "cell-2", {
        text: "three more words",
        history: [{ timestamp: "2026-04-06T00:00:00Z", author: "b", validated: false }],
      })
      addCell(cells, "cell-3", { text: "" })
    })
    const result = projectDoc("proj-1", "file-a", doc)
    expect(result.file.name).toBe("Genesis.codex")
    expect(result.file.fileType).toBe("codex")
    expect(result.file.sourceLanguage).toBe("en")
    expect(result.file.targetLanguage).toBe("fr")
    expect(result.file.cellCount).toBe(3)
    expect(result.file.approvedCount).toBe(1)
    expect(result.file.wordCount).toBe(2 + 3 + 0)
    expect(result.file.lastEditAt).toBe(Date.parse("2026-04-06T00:00:00Z"))
    doc.destroy()
  })

  it("contentHash is stable for identical text and changes with edits", () => {
    const doc1 = makeDoc(({ cells }) => addCell(cells, "c", { text: "hello" }))
    const doc2 = makeDoc(({ cells }) => addCell(cells, "c", { text: "hello" }))
    const doc3 = makeDoc(({ cells }) => addCell(cells, "c", { text: "helloo" }))
    const h1 = projectDoc("p", "f", doc1).cells[0].contentHash
    const h2 = projectDoc("p", "f", doc2).cells[0].contentHash
    const h3 = projectDoc("p", "f", doc3).cells[0].contentHash
    expect(h1).toBe(h2)
    expect(h3).not.toBe(h1)
    doc1.destroy()
    doc2.destroy()
    doc3.destroy()
  })

  it("falls back to empty string / 0 when a cell has no translatedXml or history", () => {
    const doc = makeDoc(({ cells }) => {
      const c = new Y.Map()
      c.set("id", "bare")
      cells.set("bare", c)
    })
    const result = projectDoc("p", "f", doc)
    expect(result.cells[0].contentText).toBe("")
    expect(result.cells[0].wordCount).toBe(0)
    expect(result.cells[0].validated).toBe(0)
    expect(result.cells[0].lastEditAt).toBe(0)
    expect(result.cells[0].lastEditor).toBeNull()
    doc.destroy()
  })
})

describe("diffProjection", () => {
  function twoCellDoc(text1: string, text2: string): Y.Doc {
    return makeDoc(({ cells }) => {
      addCell(cells, "cell-1", { text: text1 })
      addCell(cells, "cell-2", { text: text2 })
    })
  }

  it("first call with empty prior returns every cell and populates fingerprints", () => {
    const doc = twoCellDoc("a", "b")
    const full = projectDoc("p", "f", doc)
    const prior = new Map<string, string>()
    const diffed = diffProjection(full, prior)
    expect(diffed.cells).toHaveLength(2)
    expect(prior.size).toBe(2)
    expect(prior.get("cell-1")).toBe(cellFingerprint(full.cells[0]))
    doc.destroy()
  })

  it("second call with same state returns zero cells (the common idle case)", () => {
    const doc = twoCellDoc("a", "b")
    const prior = new Map<string, string>()
    diffProjection(projectDoc("p", "f", doc), prior) // seed
    const diffed = diffProjection(projectDoc("p", "f", doc), prior)
    expect(diffed.cells).toHaveLength(0)
    // file rollup is still present so callers always upsert files
    expect(diffed.file.cellCount).toBe(2)
    doc.destroy()
  })

  it("returns only the cells whose content changed", () => {
    const doc1 = twoCellDoc("hello", "world")
    const prior = new Map<string, string>()
    diffProjection(projectDoc("p", "f", doc1), prior)
    doc1.destroy()

    const doc2 = twoCellDoc("hello", "different")
    const diffed = diffProjection(projectDoc("p", "f", doc2), prior)
    expect(diffed.cells).toHaveLength(1)
    expect(diffed.cells[0].cellId).toBe("cell-2")
    doc2.destroy()
  })

  it("flipping validated without text change still projects the cell", () => {
    const doc1 = makeDoc(({ cells }) =>
      addCell(cells, "c", {
        text: "stable",
        history: [{ timestamp: "2026-04-01T00:00:00Z", author: "a", validated: false }],
      })
    )
    const prior = new Map<string, string>()
    diffProjection(projectDoc("p", "f", doc1), prior)
    doc1.destroy()

    const doc2 = makeDoc(({ cells }) =>
      addCell(cells, "c", {
        text: "stable",
        history: [
          { timestamp: "2026-04-01T00:00:00Z", author: "a", validated: false },
          { timestamp: "2026-04-02T00:00:00Z", author: "b", validated: true },
        ],
      })
    )
    const diffed = diffProjection(projectDoc("p", "f", doc2), prior)
    expect(diffed.cells).toHaveLength(1)
    expect(diffed.cells[0].validated).toBe(1)
    doc2.destroy()
  })

  it("prunes fingerprints for cells that were deleted between ticks", () => {
    const doc1 = twoCellDoc("a", "b")
    const prior = new Map<string, string>()
    diffProjection(projectDoc("p", "f", doc1), prior)
    expect(prior.size).toBe(2)
    doc1.destroy()

    // Next doc only has cell-1 — cell-2 was removed.
    const doc2 = makeDoc(({ cells }) => addCell(cells, "cell-1", { text: "a" }))
    diffProjection(projectDoc("p", "f", doc2), prior)
    expect(prior.size).toBe(1)
    expect(prior.has("cell-2")).toBe(false)
    doc2.destroy()
  })
})
