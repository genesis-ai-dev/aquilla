import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import {
  SAMPLE_NOTES,
  BIBLICA_STORY_PATH,
  makeBiblicaIdml,
} from "@/lib/biblica/__fixtures__/biblica-idml"
import { selectBiblicaStudyNotes } from "@/lib/biblica/study-notes"
import { extractBiblicaStudyNoteStrings } from "./biblica"

describe("Biblica study-notes parser adapter", () => {
  it("maps each selected note to one protected IDML cell with its book and chapter range", async () => {
    const buffer = await makeBiblicaIdml()
    const parsed = await parseIdml(buffer)
    const { strings, bookCodes, skipped } = await extractBiblicaStudyNoteStrings(
      buffer,
      async () => parsed,
    )

    expect(strings.map((cell) => [cell.original, cell.section])).toEqual([
      [SAMPLE_NOTES.preface, "GEN Preface"],
      [SAMPLE_NOTES.afterChapterOne, "GEN 1"],
      [SAMPLE_NOTES.afterChaptersTwoToThree, "GEN 2-3"],
      [SAMPLE_NOTES.psalmHeading, "GEN 2"],
      [SAMPLE_NOTES.psalmNote, "GEN 2"],
      // One cell per line of the reference-list paragraph.
      [SAMPLE_NOTES.referenceList[0], "GEN 2"],
      [SAMPLE_NOTES.referenceList[1], "GEN 2"],
      [SAMPLE_NOTES.referenceList[2], "GEN 2"],
      // One cell per sentence of the note block.
      [SAMPLE_NOTES.noteBlockSentences[0], "GEN 2"],
      [SAMPLE_NOTES.noteBlockSentences[1], "GEN 2"],
      [SAMPLE_NOTES.noteBlockSentences[2], "GEN 2"],
    ])
    expect(bookCodes).toEqual(["GEN"])
    expect(skipped).toEqual({ verseUnitCount: 5, otherUnitCount: 2 })

    for (const cell of strings) {
      expect(cell.globalReferences).toEqual(["GEN"])
      expect(cell.type).toBe("text")
      expect(cell.sourceLocator).toMatchObject({ kind: "idml", memberPath: BIBLICA_STORY_PATH })
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.biblica).toMatchObject({ version: 1, contentType: "notes", bookCode: "GEN" })
    }
    // The paragraph style is retained so a note's role stays auditable after import.
    expect(strings[1].metadata?.biblica).toMatchObject({
      paragraphStyle: "ParagraphStyle/intro%3aipi",
    })
  })

  it("carries the rejoin ranges only on cells that are part of a sliced note block", async () => {
    const buffer = await makeBiblicaIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractBiblicaStudyNoteStrings(buffer, async () => parsed)

    const sentences = strings.filter((cell) => (
      SAMPLE_NOTES.noteBlockSentences.some((sentence) => cell.original === sentence)
    ))
    expect(sentences).toHaveLength(3)
    expect(sentences.map((cell) => cell.metadata?.idmlRejoin)).toEqual([
      { version: 1, index: 0, count: 3, ranges: [expect.objectContaining({ slot: 0, start: 0 })] },
      { version: 1, index: 1, count: 3, ranges: [expect.any(Object)] },
      { version: 1, index: 2, count: 3, ranges: [expect.any(Object)] },
    ])
    // Whole-unit cells carry no bucket, so nothing changes for them on export.
    for (const cell of strings.filter((candidate) => !sentences.includes(candidate))) {
      expect(cell.metadata?.idmlRejoin).toBeUndefined()
    }
  })

  it("keeps every cell's identity and protected anchors identical to its selected unit", async () => {
    const buffer = await makeBiblicaIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractBiblicaStudyNoteStrings(buffer, async () => parsed)
    const { notes } = selectBiblicaStudyNotes(parsed.units)

    expect(strings).toHaveLength(notes.length)
    expect(new Set(strings.map((cell) => cell.id)).size).toBe(strings.length)
    for (const [index, cell] of strings.entries()) {
      const unit = notes[index]!.unit
      expect(cell.id).toBe(unit.id)
      expect(cell.originalHtml).toBe(unit.sourceHtml)
      expect(cell.sourceLocator).toEqual(unit.locator)

      // A cell is either a whole paragraph or one of its lines, so its locator
      // always addresses slots of a paragraph the engine parsed — that is what a
      // strict export needs to place the translation back.
      const paragraph = parsed.units.find((candidate) => (
        candidate.locator.elementPath === unit.locator.elementPath
      ))
      expect(paragraph).toBeDefined()
      expect(unit.locator.sourceBlockHash).toBe(paragraph!.locator.sourceBlockHash)
      expect(paragraph!.locator.slotIndexes).toEqual(
        expect.arrayContaining([...unit.locator.slotIndexes]),
      )

      // The target starts as the exact protected shell with no words, so a
      // strict export can still write it back into the original package.
      const validation = validateIdmlTranslation(
        cell.originalHtml!,
        cell.translatedHtml!,
        cell.metadata!.idml as IdmlFormatMetadataV2,
      )
      expect(validation.valid).toBe(true)
      expect(validation.slots.join("")).toBe("")
    }
  })

  it("parses losslessly with the generic profile and forwards cancellation and progress", async () => {
    const buffer = await makeBiblicaIdml()
    const parsed = await parseIdml(buffer)
    const parse = vi.fn(async () => parsed)
    const controller = new AbortController()
    const onProgress = vi.fn()

    await extractBiblicaStudyNoteStrings(buffer, parse, {
      signal: controller.signal,
      onProgress,
    })

    // "biblica" is a manifest label, not a filter: notes selection happens here,
    // after the engine has parsed every literal location.
    expect(parse).toHaveBeenCalledWith(buffer, "generic", {
      signal: controller.signal,
      onProgress,
    })
  })

  it("returns no cells for an IDML package that has no note paragraphs", async () => {
    const buffer = await makeBiblicaIdml([
      `<ParagraphStyleRange Self="p1" AppliedParagraphStyle="ParagraphStyle/meta%3arh">`
        + `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain">`
        + `<Content>GENESIS 1</Content></CharacterStyleRange></ParagraphStyleRange>`,
    ])
    const parsed = await parseIdml(buffer)
    const { strings, bookCodes } = await extractBiblicaStudyNoteStrings(buffer, async () => parsed)

    expect(strings).toEqual([])
    expect(bookCodes).toEqual([])
  })
})
