import { describe, expect, it } from "vitest"
import type { CellStore } from "@/hooks/useActiveCellStore"
import { createEditorStructureCache } from "@/lib/editor-structure-cache"
import { createHealthCardNamer } from "@/lib/health/health-card-rows"
import { applyColumnMapping, mappedRowsToStrings } from "@/lib/parsers/spreadsheet"
import type { OrderedBy, TranslatableString } from "@/lib/parsers/types"
import { cellNumberLabel, importDisplayLabel } from "@/lib/scripture-reference"
import { importedLines, lineStore, type TestLine, LINE_WORDS } from "@/test-utils/line-store"

// AQU-2278 round 3: a line is named exactly as its row shows it. The # column
// below is computed the way EditorTable computed it before this change (its
// own `cellNumberLabel` call, `scriptureNumbering` from the file's chapters),
// independently of src/lib/cells/line-name.ts, so the two can be compared.
function tableNumbers(store: CellStore, orderedBy?: OrderedBy): Map<string, string | null> {
  const ids = store.getCellIdsForLens(orderedBy)
  const { sequentialNumberByCellId, versePartByCellId } = createEditorStructureCache().read(ids, store)
  const scriptureNumbering = store.getNavigationIndex(ids).every((entry) =>
    entry.kind === "chapter" || entry.kind === "chapter-range" || entry.kind === "preface")
  return new Map(ids.map((id, index) => {
    const view = store.getCellView(id)!
    return [id, cellNumberLabel({
      lineNumbersEnabled: true,
      cellType: view.type,
      canonicalRef: view.group,
      sourceCanonicalRef: view.globalReferences?.[0],
      scriptureNumbering,
      rowIndex: index,
      contentNumber: sequentialNumberByCellId.get(id) ?? index + 1,
      displayLabel: importDisplayLabel(view.metadata),
      versePart: versePartByCellId.get(id),
    })]
  }))
}

/** What the card calls each line, and what its row's # column shows. */
function both(lines: TestLine[], orderedBy?: OrderedBy) {
  const store = lineStore(lines)
  const ids = store.getCellIdsForLens(orderedBy)
  const card = createHealthCardNamer(store)(ids, orderedBy, LINE_WORDS)
  const table = tableNumbers(store, orderedBy)
  return { card: Object.fromEntries(ids.map((id, i) => [id, card[i]])), table: Object.fromEntries(table) }
}

const doc = (): TestLine[] => importedLines([
  { id: "t", original: "Title", type: "heading" },
  { id: "p1", original: "First", type: "text", paragraphStart: true },
  { id: "p2", original: "Second", type: "text", paragraphStart: true },
  { id: "p3", original: "Third", type: "text", paragraphStart: true },
] as TranslatableString[], "docx")

describe("a line's name carries the number its row shows", () => {
  it("a spreadsheet with a header row: the sheet's own row numbers", () => {
    const sheet = [["Source", "Target"], ["Hello", ""], ["", ""], ["World", ""], ["Again", ""]]
    const mapped = applyColumnMapping(sheet, { sourceCol: 0, targetCol: 1, labelCol: null, startCol: null, endCol: null, castCol: null } as never, true)
    const lines = importedLines(mappedRowsToStrings(mapped), "csv")
    const { card, table } = both(lines)
    const ids = lines.map((l) => l.id)
    expect(ids.map((id) => table[id])).toEqual(["2", "4", "5"])
    expect(ids.map((id) => card[id])).toEqual(["row 2", "row 4", "row 5"])
  })

  it("a document after a line is added: the added line's number, and the rest keep theirs", () => {
    const [title, p1, p2, p3] = doc()
    const { card, table } = both([title, p1, { id: "new", text: "added", userAdded: true }, p2, p3])
    expect([table.p1, table.new, table.p2, table.p3]).toEqual(["1", "2", "2", "3"])
    expect([card.p1, card.new, card.p2, card.p3]).toEqual(["row 1", "row 2", "row 2", "row 3"])
    // A heading shows no number; it is called by its words.
    expect(table.t).toBeNull()
    expect(card.t).toBe("Title")
  })

  it("a document after a line is hidden: the numbers stay put", () => {
    const [title, p1, p2, p3] = doc()
    const { card, table } = both([title, p1, { ...p2, hidden: true }, p3])
    expect([table.p1, table.p3]).toEqual(["1", "3"])
    expect([card.p1, card.p3]).toEqual(["row 1", "row 3"])
  })

  it("a Bible with a line someone added: verses by reference, the added line by its words", () => {
    const lines = importedLines([
      { id: "v4", original: "v4", type: "verse", globalReferences: ["RUT 1:4"] },
      { id: "v5", original: "v5", type: "verse", globalReferences: ["RUT 1:5"] },
    ] as TranslatableString[], "usfm")
    const { card, table } = both([lines[0], { id: "mine", text: "my note", userAdded: true }, lines[1]])
    expect(table.mine).toBeNull()
    expect(card).toEqual({ v4: "RUT 1:4", mine: "my note", v5: "RUT 1:5" })
  })

  it("a Codex-migrated IDML file shows no numbers: its lines go by their label, else their words", () => {
    const meta = { aquillaImport: { version: 1, kind: "paragraph", displayLabel: null } }
    const lines: TestLine[] = [
      { id: "a", text: "Alpha", metadata: { ...meta, cellLabel: "Opening" } },
      { id: "b", text: "Beta", metadata: meta },
      { id: "c", text: "", metadata: meta },
    ]
    const before = both(lines)
    expect(Object.values(before.table)).toEqual([null, null, null])
    expect(before.card).toEqual({ a: "Opening", b: "Beta", c: "(empty line)" })

    // Adding one line numbers only that line, as the table does.
    const after = both([lines[0], { id: "n", text: "new one", userAdded: true }, lines[1], lines[2]])
    expect(after.table).toEqual({ a: null, n: "1", b: null, c: null })
    expect(after.card).toEqual({ a: "Opening", n: "row 1", b: "Beta", c: "(empty line)" })
  })
})
