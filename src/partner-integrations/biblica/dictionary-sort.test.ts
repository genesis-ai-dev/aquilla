import { describe, expect, it } from "vitest"
import {
  dictionaryCollationLetter,
  groupDictionaryEntries,
  OTHER_LETTER,
  sortDictionaryEntries,
  type DictionaryCell,
} from "./dictionary-sort"

const HEADING = "head%3ams1"
const HEADWORD = "intro%3aip_hw"
const EXPLANATION = "intro%3aip"

function heading(id: string, text: string): DictionaryCell {
  return { id, paragraphStyle: HEADING, text }
}
function headword(id: string, text: string): DictionaryCell {
  return { id, paragraphStyle: HEADWORD, text }
}
function explanation(id: string, text: string): DictionaryCell {
  return { id, paragraphStyle: EXPLANATION, text }
}

/**
 * A miniature French dictionary in English source order: the C section holds
 * "Church" → "Église", the A section holds "Altar" → "Autel".
 */
function frenchVolume(): DictionaryCell[] {
  return [
    heading("h-a", "A"),
    headword("hw-altar", "Autel"),
    explanation("ex-altar-1", "Table sur laquelle on offrait les sacrifices."),
    explanation("ex-altar-2", "Voir aussi: sacrifice."),
    headword("hw-angel", "Ange"),
    explanation("ex-angel-1", "Messager de Dieu."),
    heading("h-c", "C"),
    headword("hw-church", "Église"),
    explanation("ex-church-1", "L'assemblée des croyants."),
  ]
}

describe("groupDictionaryEntries", () => {
  it("infers the headword style from the paragraph after a letter heading", () => {
    expect(groupDictionaryEntries(frenchVolume()).headwordStyle).toBe(HEADWORD)
  })

  it("keeps each headword with the explanation paragraphs that follow it", () => {
    const { blocks } = groupDictionaryEntries(frenchVolume())
    const entries = blocks.filter((block) => block.kind === "entry")
    expect(entries.map((entry) => [entry.headword, entry.cellIds])).toEqual([
      ["Autel", ["hw-altar", "ex-altar-1", "ex-altar-2"]],
      ["Ange", ["hw-angel", "ex-angel-1"]],
      ["Église", ["hw-church", "ex-church-1"]],
    ])
  })

  it("files text ahead of the first letter heading as preamble, not as an entry", () => {
    const { blocks } = groupDictionaryEntries([
      { id: "title", paragraphStyle: "title%3amt1", text: "Dictionnaire biblique" },
      ...frenchVolume(),
    ])
    expect(blocks[0]).toMatchObject({ kind: "preamble", cellIds: ["title"] })
  })

  it("reports no headword style when the volume carries none", () => {
    const grouping = groupDictionaryEntries([
      { id: "a", text: "Autel" },
      { id: "b", text: "Une table." },
    ])
    expect(grouping.headwordStyle).toBeNull()
  })

  it("accepts both the URL-encoded and the plain colon form of the heading style", () => {
    const plain = groupDictionaryEntries([
      { id: "h", paragraphStyle: "head:ms1", text: "A" },
      { id: "hw", paragraphStyle: "intro:ip_hw", text: "Autel" },
    ])
    expect(plain.headwordStyle).toBe("intro:ip_hw")
  })
})

describe("dictionaryCollationLetter", () => {
  it("folds a French accent onto its base letter", () => {
    expect(dictionaryCollationLetter("Église", { locale: "fr" })).toBe("E")
    expect(dictionaryCollationLetter("Éphèse", { locale: "fr" })).toBe("E")
  })

  it("upper-cases a lowercase headword for the locale", () => {
    expect(dictionaryCollationLetter("autel", { locale: "fr" })).toBe("A")
  })

  it("folds Arabic alef variants and strips harakat", () => {
    expect(dictionaryCollationLetter("أب", { locale: "ar" })).toBe("ا")
    expect(dictionaryCollationLetter("ابن", { locale: "ar" })).toBe("ا")
    expect(dictionaryCollationLetter("بَيت", { locale: "ar" })).toBe("ب")
  })

  it("only drops a leading article when one is configured", () => {
    expect(dictionaryCollationLetter("الكنيسة", { locale: "ar" })).toBe("ا")
    expect(
      dictionaryCollationLetter("الكنيسة", { locale: "ar", ignoreLeadingArticles: ["ال"] }),
    ).toBe("ك")
  })

  it("skips leading punctuation and falls back to the other bucket", () => {
    expect(dictionaryCollationLetter("«Église»", { locale: "fr" })).toBe("E")
    expect(dictionaryCollationLetter("— 1 —", { locale: "fr" })).toBe(OTHER_LETTER)
  })
})

describe("sortDictionaryEntries", () => {
  it("re-orders entries by the target alphabet, moving explanations with the headword", () => {
    const result = sortDictionaryEntries(frenchVolume(), { locale: "fr" })
    if (!result.ok) throw new Error(result.detail)
    expect(result.order).toEqual([
      "h-a",
      "hw-angel",
      "ex-angel-1",
      "hw-altar",
      "ex-altar-1",
      "ex-altar-2",
      "h-c",
      "hw-church",
      "ex-church-1",
    ])
  })

  it("regenerates the per-letter headings for the target alphabet", () => {
    const result = sortDictionaryEntries(frenchVolume(), { locale: "fr" })
    if (!result.ok) throw new Error(result.detail)
    expect(result.letters).toEqual([
      { letter: "A", headingCellId: "h-a", entryCount: 2 },
      { letter: "E", headingCellId: "h-c", entryCount: 1 },
    ])
  })

  it("retires a source heading the target alphabet no longer needs", () => {
    // Both French headwords begin with A, so the English C section is surplus.
    const cells = [
      heading("h-a", "A"),
      headword("hw-altar", "Autel"),
      explanation("ex-altar", "Une table."),
      heading("h-c", "C"),
      headword("hw-ark", "Arche"),
      explanation("ex-ark", "Un coffre."),
    ]
    const result = sortDictionaryEntries(cells, { locale: "fr" })
    if (!result.ok) throw new Error(result.detail)
    expect(result.letters).toEqual([{ letter: "A", headingCellId: "h-a", entryCount: 2 }])
    expect(result.retiredHeadingCellIds).toEqual(["h-c"])
  })

  it("keeps preamble ahead of the alphabet", () => {
    const result = sortDictionaryEntries(
      [
        { id: "title", paragraphStyle: "title%3amt1", text: "Dictionnaire" },
        ...frenchVolume(),
      ],
      { locale: "fr" },
    )
    if (!result.ok) throw new Error(result.detail)
    expect(result.order[0]).toBe("title")
  })

  it("parks an untranslated entry after the alphabet instead of filing it under English", () => {
    const cells = [
      heading("h-a", "A"),
      headword("hw-altar", "Autel"),
      explanation("ex-altar", "Une table."),
      headword("hw-zeal", ""),
      explanation("ex-zeal", ""),
    ]
    const result = sortDictionaryEntries(cells, { locale: "fr" })
    if (!result.ok) throw new Error(result.detail)
    expect(result.untranslatedEntryCellIds).toEqual(["hw-zeal", "ex-zeal"])
    expect(result.order.slice(-2)).toEqual(["hw-zeal", "ex-zeal"])
  })

  it("orders an Arabic volume by Arabic collation", () => {
    const cells = [
      heading("h-a", "A"),
      headword("hw-1", "كنيسة"),
      explanation("ex-1", "جماعة المؤمنين."),
      headword("hw-2", "بيت"),
      explanation("ex-2", "مسكن."),
      heading("h-b", "B"),
      headword("hw-3", "أب"),
      explanation("ex-3", "والد."),
    ]
    const result = sortDictionaryEntries(cells, { locale: "ar" })
    if (!result.ok) throw new Error(result.detail)
    expect(result.order.filter((id) => id.startsWith("hw-"))).toEqual(["hw-3", "hw-2", "hw-1"])
    expect(result.letters.map((entry) => entry.letter)).toEqual(["ا", "ب", "ك"])
  })

  it("never mutates the cells it is given", () => {
    const cells = frenchVolume()
    const before = JSON.stringify(cells)
    sortDictionaryEntries(cells, { locale: "fr" })
    expect(JSON.stringify(cells)).toBe(before)
  })

  it("covers every input cell exactly once", () => {
    const cells = frenchVolume()
    const result = sortDictionaryEntries(cells, { locale: "fr" })
    if (!result.ok) throw new Error(result.detail)
    expect([...result.order].sort()).toEqual(cells.map((cell) => cell.id).sort())
  })

  it("is deterministic when two headwords collate equal", () => {
    const cells = [
      heading("h-a", "A"),
      headword("hw-1", "Arche"),
      explanation("ex-1", "Le coffre."),
      headword("hw-2", "Arche"),
      explanation("ex-2", "Le navire."),
    ]
    const result = sortDictionaryEntries(cells, { locale: "fr" })
    if (!result.ok) throw new Error(result.detail)
    expect(result.order).toEqual(["h-a", "hw-1", "ex-1", "hw-2", "ex-2"])
  })

  it("refuses a volume it cannot find a headword style in", () => {
    const result = sortDictionaryEntries([{ id: "a", text: "Autel" }], { locale: "fr" })
    expect(result).toMatchObject({ ok: false, reason: "no-headword-style" })
  })

  it("refuses a volume of bare headings, which names no headword style", () => {
    const result = sortDictionaryEntries(
      [heading("h-a", "A"), heading("h-b", "B")],
      { locale: "fr" },
    )
    expect(result).toMatchObject({ ok: false, reason: "no-headword-style" })
  })
})
