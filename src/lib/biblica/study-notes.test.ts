import { describe, expect, it } from "vitest"
import {
  parseIdml,
  type IdmlTextSlot,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import { selectBiblicaStudyNotes } from "./study-notes"
import {
  SAMPLE_NOTES,
  biblicaSampleStory,
  makeBiblicaIdml,
  note,
  noteList,
  openVerse,
  paragraph,
  run,
} from "./__fixtures__/biblica-idml"

/**
 * Synthetic units for branches that the shared engine deliberately never emits
 * (it drops whitespace-only paragraphs before an adapter can see them).
 */
function syntheticUnit(
  paragraphStyleId: string | undefined,
  slots: readonly (readonly [text: string, characterStyleId: string])[],
  order = 0,
): IdmlTranslationUnit {
  const textSlots: IdmlTextSlot[] = slots.map(([text, characterStyleId], index) => ({
    index,
    text,
    characterStyleId,
    editable: true,
  }))
  return {
    id: `synthetic-${order}`,
    order,
    sourceText: textSlots.map((slot) => slot.text).join(""),
    sourceHtml: "",
    locator: {
      kind: "idml",
      memberPath: "Stories/Story_u1.xml",
      elementPath: `/Story[1]/ParagraphStyleRange[${order + 1}]`,
      scope: "story-paragraph",
      part: 0,
      slotIndexes: textSlots.map((slot) => slot.index),
      sourceBlockHash: `hash-${order}`,
    },
    metadata: {
      version: 2,
      slotCount: textSlots.length,
      editableSlotIndexes: textSlots.map((slot) => slot.index),
      protectedTokenCount: 0,
      anchorSequenceHash: `anchors-${order}`,
    },
    slots: textSlots,
    protectedTokens: [],
    diagnostics: [],
    ...(paragraphStyleId ? { paragraphStyleId } : {}),
  }
}

const PLAIN = "CharacterStyle/$ID/[No character style]"

describe("Biblica study-note selection", () => {
  it("imports only the notes from a real parsed Biblica package, labelled by chapter range", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml())
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => [entry.unit.sourceText, entry.chapterLabel])).toEqual([
      [SAMPLE_NOTES.preface, "Preface"],
      [SAMPLE_NOTES.afterChapterOne, "1"],
      [SAMPLE_NOTES.afterChaptersTwoToThree, "2-3"],
      [SAMPLE_NOTES.psalmHeading, "2"],
      [SAMPLE_NOTES.psalmNote, "2"],
      // The reference list is one IDML paragraph; each line is its own cell.
      [SAMPLE_NOTES.referenceList[0], "2"],
      [SAMPLE_NOTES.referenceList[1], "2"],
      [SAMPLE_NOTES.referenceList[2], "2"],
      // The note block is one paragraph; each sentence is its own cell.
      [SAMPLE_NOTES.noteBlockSentences[0], "2"],
      [SAMPLE_NOTES.noteBlockSentences[1], "2"],
      [SAMPLE_NOTES.noteBlockSentences[2], "2"],
    ])
    expect(selection.notes.every((entry) => entry.bookCode === "GEN")).toBe(true)

    // Every scripture paragraph — including the run-on verse's continuation —
    // is accounted for as skipped, not silently dropped.
    expect(selection.verseUnitCount).toBe(5)
    // The book marker and the running header are neither scripture nor notes.
    expect(selection.otherUnitCount).toBe(2)
    // 7 note paragraphs + 5 scripture + 2 furniture: no parsed unit is unclassified.
    expect(parsed.units).toHaveLength(7 + selection.verseUnitCount + selection.otherUnitCount)
  })

  it("cuts a multi-sentence note block into one cell per sentence, with the ranges to rejoin it", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      note("p-block", SAMPLE_NOTES.noteBlock),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => entry.unit.sourceText))
      .toEqual([...SAMPLE_NOTES.noteBlockSentences])
    // A sentence is finer than IDML can address, so every cell keeps the
    // paragraph's own locator and says which part of it it holds instead.
    const paragraphLocator = parsed.units[1]!.locator
    expect(selection.notes.every((entry) => (
      entry.unit.locator.elementPath === paragraphLocator.elementPath
      && entry.unit.locator.part === paragraphLocator.part
    ))).toBe(true)
    expect(new Set(selection.notes.map((entry) => entry.unit.id)).size).toBe(3)
    // The ranges tile the paragraph's single slot exactly, in order: nothing is
    // duplicated and nothing is lost, which is what export relies on.
    const [first, second, third] = SAMPLE_NOTES.noteBlockSentences
    expect(selection.notes.map((entry) => entry.rejoin)).toEqual([
      { index: 0, count: 3, ranges: [{ slot: 0, start: 0, end: first.length }] },
      {
        index: 1,
        count: 3,
        ranges: [{ slot: 0, start: first.length, end: first.length + second.length }],
      },
      {
        index: 2,
        count: 3,
        ranges: [{
          slot: 0,
          start: first.length + second.length,
          end: first.length + second.length + third.length,
        }],
      },
    ])
    expect(first.length + second.length + third.length).toBe(SAMPLE_NOTES.noteBlock.length)
  })

  it("leaves a note that is one sentence as a single whole cell", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      note("p-n", SAMPLE_NOTES.preface),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes).toHaveLength(1)
    // No rejoin bucket means the cell is the whole unit its locator names, which
    // is what every IDML cell was before slicing existed.
    expect(selection.notes[0]!.rejoin).toBeUndefined()
    expect(selection.notes[0]!.unit).toBe(parsed.units[1])
  })

  it("gives each line of a list paragraph its own cell over its own slots", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "ACT")),
      noteList("p-list", SAMPLE_NOTES.referenceList),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => entry.unit.sourceText))
      .toEqual([...SAMPLE_NOTES.referenceList])
    // Every line is a projection of the one paragraph: same element, distinct
    // part, disjoint slots. That is what lets export merge them back together.
    const locators = selection.notes.map((entry) => entry.unit.locator)
    expect(new Set(locators.map((locator) => locator.elementPath)).size).toBe(1)
    expect(locators.map((locator) => locator.part)).toEqual([0, 1, 2])
    expect(locators.map((locator) => [...locator.slotIndexes])).toEqual([[0], [1], [2]])
    expect(new Set(selection.notes.map((entry) => entry.unit.id)).size).toBe(3)
    expect(selection.notes.every((entry) => entry.unit.slots.length === 1)).toBe(true)
  })

  it("drops a list line that carries no words while keeping the lines around it", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "ACT")),
      noteList("p-list", ["First item.", "   ", "Second item."]),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => entry.unit.sourceText))
      .toEqual(["First item.", "Second item."])
    // The discarded line owns no cell, so its part number is simply absent; its
    // slot keeps the publisher's spacing when the package is exported.
    expect(selection.notes.map((entry) => entry.unit.locator.part)).toEqual([0, 2])
  })

  it("never imports scripture text as a note", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml())
    const selection = selectBiblicaStudyNotes(parsed.units)

    const imported = selection.notes.map((entry) => entry.unit.sourceText).join("\n")
    expect(imported).not.toContain("In the beginning God created")
    expect(imported).not.toContain("No shrub had yet appeared")
    expect(imported).not.toContain("working the ground")
    expect(imported).not.toContain("streams came up")
    expect(imported).not.toContain("serpent was more crafty")
  })

  it("ends a run-on verse at the next note section even when its bookend is missing", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "PSA")),
      openVerse("p-v", "3", "Many are saying of me,", "4"),
      // No closing bookend anywhere: without the note-section boundary this note
      // would be swallowed as verse continuation.
      note("p-n", "A note that must still be imported."),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => entry.unit.sourceText)).toEqual([
      "A note that must still be imported.",
    ])
    expect(selection.notes[0].chapterLabel).toBe("4")
    expect(selection.notes[0].bookCode).toBe("PSA")
  })

  it("falls back to an inline book heading when no meta:bk paragraph exists", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-head", "meta%3arh", run("$ID/[No character style]", "RUT — Ruth")),
      note("p-n", "Ruth opens in the days of the judges."),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes[0].bookCode).toBe("RUT")
  })

  it("resets book, chapter, and label state at each new book", () => {
    const units = [
      syntheticUnit("ParagraphStyle/meta%3abk", [["GEN", PLAIN]], 0),
      syntheticUnit("ParagraphStyle/cv%3ap", [
        ["9", "CharacterStyle/cv%3adc"],
        ["1", "CharacterStyle/cv%3av1"],
        ["1", "CharacterStyle/meta%3av"],
        ["Genesis nine.", PLAIN],
        ["1", "CharacterStyle/meta%3av"],
      ], 1),
      syntheticUnit("ParagraphStyle/meta%3abk", [["EXO", PLAIN]], 2),
      syntheticUnit("ParagraphStyle/intro%3aip", [["Exodus begins in Egypt.", PLAIN]], 3),
    ]

    const selection = selectBiblicaStudyNotes(units)

    expect(selection.notes).toHaveLength(1)
    expect(selection.notes[0].bookCode).toBe("EXO")
    // Genesis 9 must not leak into the new book's first label.
    expect(selection.notes[0].chapterLabel).toBe("Preface")
  })

  it("skips note paragraphs whose only content is structural glue", () => {
    const units = [
      syntheticUnit("ParagraphStyle/intro%3aip", [["<?ACE 3?>", PLAIN], ["  ", PLAIN]], 0),
      syntheticUnit("ParagraphStyle/intro%3aip", [["\u2019", PLAIN]], 1),
      syntheticUnit("ParagraphStyle/intro%3aip", [
        ["dejiny", "CharacterStyle/Source Serif Pro"],
      ], 2),
      syntheticUnit("ParagraphStyle/intro%3aip", [
        ["Zmluvné", PLAIN],
        ["\u02BC", "CharacterStyle/Source Serif Pro"],
        ["dejiny", PLAIN],
      ], 3),
    ]

    const selection = selectBiblicaStudyNotes(units)

    // Only the paragraph with real words survives, and it keeps every slot so
    // the protected structure still matches the source package.
    expect(selection.notes).toHaveLength(1)
    expect(selection.notes[0].unit.slots).toHaveLength(3)
    expect(selection.otherUnitCount).toBe(3)
  })

  it("classifies a paragraph with no applied style as neither scripture nor a note", () => {
    const selection = selectBiblicaStudyNotes([
      syntheticUnit(undefined, [["Colophon.", PLAIN]], 0),
    ])

    expect(selection.notes).toEqual([])
    expect(selection.otherUnitCount).toBe(1)
    expect(selection.verseUnitCount).toBe(0)
  })

  it("tracks Psalms-style meta:c chapter markers", () => {
    const units = [
      syntheticUnit("ParagraphStyle/meta%3abk", [["PSA", PLAIN]], 0),
      syntheticUnit("ParagraphStyle/cv%3ap", [
        ["23:", "CharacterStyle/meta%3ac"],
        ["1", "CharacterStyle/cv%3av1"],
        ["1", "CharacterStyle/meta%3av"],
        ["The LORD is my shepherd.", PLAIN],
        ["1", "CharacterStyle/meta%3av"],
      ], 1),
      syntheticUnit("ParagraphStyle/intro%3aipi", [["A psalm of trust.", PLAIN]], 2),
    ]

    const selection = selectBiblicaStudyNotes(units)

    expect(selection.notes[0].chapterLabel).toBe("23")
  })

  it("returns nothing for a package with no note paragraphs", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml(
      biblicaSampleStory.filter((block) => !block.includes("intro%3a")),
    ))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes).toEqual([])
    expect(selection.verseUnitCount).toBeGreaterThan(0)
  })
})
