import { describe, expect, it } from "vitest"
import { countReimportDiff, type ReimportCountedCell } from "./reimport-diff"

function cell(partial: Partial<ReimportCountedCell> & Pick<ReimportCountedCell, "cellId" | "value">): ReimportCountedCell {
  return partial
}

describe("countReimportDiff", () => {
  it("counts added and updated cells by unit key, then cell id, then reference", () => {
    const cases: {
      name: string
      incoming: ReimportCountedCell[]
      existing: ReimportCountedCell[]
      added: number
      updated: number
      addedCells?: { text: string; number: number }[]
      updatedCells?: { text: string; previous?: string; number: number }[]
    }[] = [
      {
        name: "same unit and text",
        incoming: [cell({ cellId: "new-id", value: "In the beginning", metadata: { aquillaImport: { unitKey: "idml:story:p1:0" } } })],
        existing: [cell({ cellId: "old-id", value: "In the beginning", metadata: { aquillaImport: { unitKey: "idml:story:p1:0" } } })],
        added: 0,
        updated: 0,
      },
      {
        name: "same unit, changed text",
        incoming: [cell({ cellId: "new-id", value: "In the beginning God", metadata: { aquillaImport: { unitKey: "idml:story:p1:0" } } })],
        existing: [cell({ cellId: "old-id", value: "In the beginning", metadata: { aquillaImport: { unitKey: "idml:story:p1:0" } } })],
        added: 0,
        updated: 1,
      },
      {
        name: "formatting that leaves the words alone",
        incoming: [cell({ cellId: "c", value: "Note", valueHtml: "<b>Note</b>", metadata: { aquillaImport: { unitKey: "k" } } })],
        existing: [cell({ cellId: "c", value: "Note", valueHtml: null, metadata: { aquillaImport: { unitKey: "k" } } })],
        added: 0,
        updated: 0,
      },
      {
        name: "a republished heading with a new story id and a different apostrophe",
        incoming: [cell({
          cellId: "incoming-heading",
          value: "Israel's covenant history",
          metadata: { aquillaImport: { unitKey: "idml:Stories/Story_u452.xml:/idPkg:Story[1]/Story[1]/ParagraphStyleRange[7]:0" } },
        })],
        existing: [cell({
          cellId: "stored-heading",
          value: "Israel\u02BCs covenant history",
          metadata: { aquillaImport: { unitKey: "idml:Stories/Story_u363.xml:/idPkg:Story[1]/Story[1]/ParagraphStyleRange[7]:0" } },
        })],
        added: 0,
        updated: 0,
      },
      {
        name: "missing html is not a change",
        incoming: [cell({ cellId: "c", value: "Note", metadata: { aquillaImport: { unitKey: "k" } } })],
        existing: [cell({ cellId: "c", value: "Note", valueHtml: null, metadata: { aquillaImport: { unitKey: "k" } } })],
        added: 0,
        updated: 0,
      },
      {
        name: "cell id when the unit key moved",
        incoming: [cell({ cellId: "c1", value: "Updated", metadata: { aquillaImport: { unitKey: "next" } } })],
        existing: [cell({ cellId: "c1", value: "Original", metadata: { aquillaImport: { unitKey: "prev" } } })],
        added: 0,
        updated: 1,
      },
      {
        name: "canonical reference when id and key both differ",
        incoming: [cell({ cellId: "incoming", value: "Same", canonicalRef: "GEN 1:1" })],
        existing: [cell({ cellId: "stored", value: "Same", canonicalRef: "GEN 1:1" })],
        added: 0,
        updated: 0,
      },
      {
        name: "no identity is an addition",
        incoming: [cell({ cellId: "fresh", value: "New note", metadata: { aquillaImport: { unitKey: "idml:story:p9:0" } } })],
        existing: [cell({ cellId: "old", value: "Old note", metadata: { aquillaImport: { unitKey: "idml:story:p1:0" } } })],
        added: 1,
        updated: 0,
      },
      {
        name: "one added and one updated",
        incoming: [
          cell({ cellId: "a", value: "Changed", metadata: { aquillaImport: { unitKey: "keep" } } }),
          cell({ cellId: "b", value: "Brand new", metadata: { aquillaImport: { unitKey: "new" } } }),
        ],
        existing: [cell({ cellId: "a", value: "Original", metadata: { aquillaImport: { unitKey: "keep" } } })],
        added: 1,
        updated: 1,
        addedCells: [{ text: "Brand new", number: 2 }],
        updatedCells: [{ text: "Changed", previous: "Original", number: 1 }],
      },
      {
        name: "a duplicated existing unit key falls through to the cell id",
        incoming: [cell({ cellId: "e1", value: "Changed", metadata: { aquillaImport: { unitKey: "dup" } } })],
        existing: [
          cell({ cellId: "e1", value: "Text", metadata: { aquillaImport: { unitKey: "dup" } } }),
          cell({ cellId: "e2", value: "Text", metadata: { aquillaImport: { unitKey: "dup" } } }),
        ],
        added: 0,
        updated: 1,
      },
    ]
    for (const entry of cases) {
      const diff = countReimportDiff(entry.incoming, entry.existing)
      expect(diff, entry.name).toMatchObject({
        added: entry.added,
        updated: entry.updated,
      })
      if (entry.addedCells) expect(diff.addedCells, entry.name).toEqual(entry.addedCells)
      if (entry.updatedCells) expect(diff.updatedCells, entry.name).toEqual(entry.updatedCells)
    }
  })
})
