import { describe, expect, it } from "vitest"
import {
  parseIdml,
  type IdmlTextSlot,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import { isBiblicaFrontBackMatterPackage, selectBiblicaStudyNotes } from "./study-notes"
import {
  FRONT_BACK_MATTER,
  SAMPLE_NOTES,
  biblicaFrontBackMatterStory,
  biblicaSampleStory,
  bookTitle,
  closedVerse,
  divisionHeading,
  layoutText,
  makeBiblicaIdml,
  note,
  noteList,
  noteWithTrailingVerseMarker,
  openVerse,
  paragraph,
  psalmsVerse,
  run,
  scriptureHeading,
  verseMarkerOnlyNote,
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
      [SAMPLE_NOTES.noteBlock, "2"],
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

  it("keeps a multi-sentence note block as one cell when sentence splitting is off", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      note("p-block", SAMPLE_NOTES.noteBlock),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units, { splitSentences: false })

    expect(selection.notes).toHaveLength(1)
    expect(selection.notes[0]!.unit.sourceText).toBe(SAMPLE_NOTES.noteBlock)
    expect(selection.notes[0]!.rejoin).toBeUndefined()
    // Lists still split per line — this fixture has no list; the whole block
    // is simply the one line-cell its paragraph already is.
    expect(selection.notes[0]!.unit).toBe(parsed.units[1])
  })

  it("cuts a multi-sentence note block into one cell per sentence, with the ranges to rejoin it", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      note("p-block", SAMPLE_NOTES.noteBlock),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units, { splitSentences: true })

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

  it("keeps a document preface separate even when its note text begins with a book code", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      note("p-global", "ISA — Notes prepared for this edition."),
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "ISA")),
      note("p-book", "Isaiah introduces the prophetic collection."),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => ({
      text: entry.unit.sourceText,
      bookCode: entry.bookCode,
      chapterLabel: entry.chapterLabel,
    }))).toEqual([
      {
        text: "ISA — Notes prepared for this edition.",
        bookCode: undefined,
        chapterLabel: "Preface",
      },
      {
        text: "Isaiah introduces the prophetic collection.",
        bookCode: "ISA",
        chapterLabel: "Preface",
      },
    ])
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

  it("imports the Psalter's layout headings and leaves the verse lines out", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "PSA")),
      note("p-title", "Psalms", "intro%3aimt1"),
      scriptureHeading("p-ms", SAMPLE_NOTES.psalmBookHeading, "head%3ams"),
      scriptureHeading("p-mr", SAMPLE_NOTES.psalmBookRange, "head%3amr_h"),
      scriptureHeading("p-cl1", "Psalm 1"),
      psalmsVerse("p-v1", "1", "1", "Blessed is the person who obeys the law of the LORD."),
      scriptureHeading("p-cl3", "Psalm 3"),
      scriptureHeading("p-d", SAMPLE_NOTES.psalmSuperscription, "head%3ad_h"),
      paragraph("p-q", "text%3aq1", run("$ID/[No character style]", "Lord, I have so many enemies!")),
      closedVerse("p-v3", "1", "Lord, I have so many enemies!"),
      note("p-n", "3:1-8 A cry for help when enemies close in.", "intro%3aimi"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => [
      entry.unit.sourceText,
      entry.chapterLabel,
      entry.bookCode,
    ])).toEqual([
      ["Psalms", "Preface", "PSA"],
      [SAMPLE_NOTES.psalmBookHeading, "Preface", "PSA"],
      [SAMPLE_NOTES.psalmBookRange, "Preface", "PSA"],
      ["Psalm 1", "1", "PSA"],
      ["Psalm 3", "3", "PSA"],
      [SAMPLE_NOTES.psalmSuperscription, "3", "PSA"],
      ["3:1-8 A cry for help when enemies close in.", "3", "PSA"],
    ])
    expect(selection.notes.map((entry) => entry.unit.sourceText).join("\n"))
      .not.toContain("Blessed is the person")
    expect(selection.notes.map((entry) => entry.unit.sourceText).join("\n"))
      .not.toContain("Lord, I have so many enemies!")
  })

  it("imports speaker lines and Psalm 119 acrostic letters", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "PSA")),
      scriptureHeading("p-cl", "Psalm 119"),
      scriptureHeading("p-qa", "Aleph", "head%3aqa"),
      closedVerse("p-v", "1", "Blessed are those whose ways are blameless."),
      paragraph("p-sng", "meta%3abk", run("$ID/[No character style]", "SNG")),
      scriptureHeading("p-sp", "She says", "head%3asp"),
      closedVerse("p-v2", "2", "Let him kiss me with the kisses of his mouth.", "1"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => [entry.unit.sourceText, entry.bookCode])).toEqual([
      ["Psalm 119", "PSA"],
      ["Aleph", "PSA"],
      ["She says", "SNG"],
    ])
  })

  it("does not swallow a Psalm heading as the continuation of an unclosed verse", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "PSA")),
      openVerse("p-v", "6", "I lie down and sleep;", "3"),
      scriptureHeading("p-cl", "Psalm 4"),
      note("p-n", "A night prayer that follows the cry of Psalm 3."),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => [entry.unit.sourceText, entry.chapterLabel])).toEqual([
      ["Psalm 4", "4"],
      ["A night prayer that follows the cry of Psalm 3.", "4"],
    ])
  })

  it("tracks Psalms-style meta:c chapter markers even when they follow the verse number", () => {
    const units = [
      syntheticUnit("ParagraphStyle/meta%3abk", [["PSA", PLAIN]], 0),
      // JOB-SNG order: cv:v, then meta:c "23:", then the verse body.
      syntheticUnit("ParagraphStyle/text%3aq1", [
        ["1", "CharacterStyle/cv%3av"],
        ["23:", "CharacterStyle/meta%3ac"],
        ["1", "CharacterStyle/meta%3av"],
        ["The LORD is my shepherd.", PLAIN],
        ["1", "CharacterStyle/meta%3av"],
      ], 1),
      syntheticUnit("ParagraphStyle/intro%3aipi", [["A psalm of trust.", PLAIN]], 2),
    ]

    const selection = selectBiblicaStudyNotes(units)

    expect(selection.notes[0].chapterLabel).toBe("23")
  })

  it("does not label Psalm 1 notes with Job's last chapter after 42:17 is flushed into intro:ie", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-job", "meta%3abk", run("$ID/[No character style]", "JOB")),
      closedVerse("p-job-v", "17", "And so Job died. He had lived for a very long time.", "42"),
      note("p-job-n", "Job passed the test that Satan had suggested."),
      paragraph("p-psa", "meta%3abk", run("$ID/[No character style]", "PSA")),
      note("p-pref", "Psalms is a book of Israel's prayers and songs."),
      // Job's closing 42:17, flushed into Psalms' intro:ie — the JOB-SNG shape.
      verseMarkerOnlyNote("p-ie", "42", "17"),
      scriptureHeading("p-cl", "Psalm 1"),
      psalmsVerse("p-v1", "1", "1", "Blessed is the person who obeys the law of the LORD."),
      note("p-n1", "Psalm 1 is a wisdom psalm about two ways to live.", "intro%3aipi"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => [
      entry.unit.sourceText,
      entry.chapterLabel,
      entry.bookCode,
    ])).toEqual([
      ["Job passed the test that Satan had suggested.", "42", "JOB"],
      ["Psalms is a book of Israel's prayers and songs.", "Preface", "PSA"],
      ["Psalm 1", "1", "PSA"],
      ["Psalm 1 is a wisdom psalm about two ways to live.", "1", "PSA"],
    ])
    expect(selection.notes.map((entry) => entry.chapterLabel).join(","))
      .not.toMatch(/42-1|42–1/)
  })

  it("imports no cell for a preface paragraph that is only the previous book's markers", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "MRK")),
      note("p-title", "The Gospel of Mark", "intro%3aimt1"),
      // Matthew's closing "28:20", flushed into Mark's preface by InDesign.
      verseMarkerOnlyNote("p-ie", "28", "20"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => entry.unit.sourceText)).toEqual([
      "The Gospel of Mark",
    ])
    expect(selection.otherUnitCount).toBe(2)
  })

  it("cuts a verse marker off the end of the note it was flushed into", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "REV")),
      noteWithTrailingVerseMarker("p-n", "The fourth vision John wrote about.", "21"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes).toHaveLength(1)
    const [only] = selection.notes
    expect(only.unit.sourceText).toBe("The fourth vision John wrote about.")
    // The cell is no longer the whole paragraph, so it says which part it owns:
    // the marker slot is left out and keeps the publisher's text on export.
    expect(only.rejoin).toEqual({
      index: 0,
      count: 1,
      ranges: [{ slot: 0, start: 0, end: "The fourth vision John wrote about.".length }],
    })
  })

  it("keeps the sentences of a note whose paragraph ends with a verse marker", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      noteWithTrailingVerseMarker("p-n", SAMPLE_NOTES.noteBlock, "7"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units, { splitSentences: true })

    expect(selection.notes.map((entry) => entry.unit.sourceText))
      .toEqual([...SAMPLE_NOTES.noteBlockSentences])
    // The dropped marker slice is not counted, so the siblings still number
    // 0..n-1 of n — which is what the exporter checks before it merges them.
    expect(selection.notes.map((entry) => entry.rejoin?.index)).toEqual([0, 1, 2])
    expect(selection.notes.every((entry) => entry.rejoin?.count === 3)).toBe(true)
    expect(selection.notes.flatMap((entry) => entry.rejoin?.ranges ?? [])
      .every((range) => range.slot === 0)).toBe(true)
  })

  it("keeps a note whose only marker sits between its words", async () => {
    const units = [
      syntheticUnit("ParagraphStyle/meta%3abk", [["PSA", PLAIN]], 0),
      syntheticUnit("ParagraphStyle/intro%3aimi", [
        ["Creation: Genesis 1:1 – 2:25.", PLAIN],
        ["8:", "CharacterStyle/meta%3ac"],
      ], 1),
    ]

    const selection = selectBiblicaStudyNotes(units)

    expect(selection.notes.map((entry) => entry.unit.sourceText))
      .toEqual(["Creation: Genesis 1:1 – 2:25."])
  })

  it("gives a division heading and its description a section of their own", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      // InDesign stores the typesetter's soft hyphens inside the heading text.
      divisionHeading("p-div", "Israel\u02BCs cove\u00adnant history"),
      note("p-div-body", "The books from Genesis to Esther record Israel's story."),
      bookTitle("p-title", "Genesis"),
      note("p-pref", SAMPLE_NOTES.preface),
      closedVerse("p-v1", "1", "In the beginning God created.", "1"),
      note("p-n1", SAMPLE_NOTES.afterChapterOne, "intro%3aipi"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes.map((entry) => [
      entry.unit.sourceText,
      entry.section?.label,
      entry.chapterLabel,
      entry.bookCode,
    ])).toEqual([
      // The heading names a group of books, so its cells carry no book and no
      // chapter range — the soft hyphens stay in the text but not in the label.
      ["Israel\u02BCs cove\u00adnant history", "Israel\u02BCs covenant history", undefined, undefined],
      [
        "The books from Genesis to Esther record Israel's story.",
        "Israel\u02BCs covenant history",
        undefined,
        undefined,
      ],
      // The book title ends the division: Genesis owns everything after it.
      ["Genesis", undefined, "Preface", "GEN"],
      [SAMPLE_NOTES.preface, undefined, "Preface", "GEN"],
      [SAMPLE_NOTES.afterChapterOne, undefined, "1", "GEN"],
    ])
  })

  it("recognizes a front/back matter volume by what it does not contain", async () => {
    const frontBack = await parseIdml(await makeBiblicaIdml(biblicaFrontBackMatterStory))
    const bookVolume = await parseIdml(await makeBiblicaIdml())

    expect(isBiblicaFrontBackMatterPackage(frontBack.units)).toBe(true)
    expect(isBiblicaFrontBackMatterPackage(bookVolume.units)).toBe(false)
    // The maps volume is artwork: nothing parses out of it at all.
    expect(isBiblicaFrontBackMatterPackage([])).toBe(true)
    // A notes-only excerpt is still a book volume — it names its book and sets
    // its text in intro/* styles, so it must not be read as layout text.
    const notesOnly = await parseIdml(await makeBiblicaIdml([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      note("p-n", SAMPLE_NOTES.preface),
    ]))
    expect(isBiblicaFrontBackMatterPackage(notesOnly.units)).toBe(false)

    // Biblica's other titles hold no study-Bible chapter markers either, but
    // they are not this importer's to read — each has a template of its own,
    // whether it groups its styles (Reach 4 Life) or names them flat (the
    // Treasure Hunt Bible, whose front matter is `par` / `toc_l2` / `fm_title`).
    for (const style of ["R4Lv4 Paragraph Styles%3aLesson body", "%21meta_par", "par", "toc_l2"]) {
      const foreign = await parseIdml(await makeBiblicaIdml([
        paragraph("p-f", style, run("$ID/[No character style]", "Whose text is this?")),
      ]))
      expect(isBiblicaFrontBackMatterPackage(foreign.units)).toBe(false)
    }

    // The cover is artwork with a few lines of type over it, set in InDesign's
    // default style — it belongs to no template, so nothing rules it out.
    const cover = await parseIdml(await makeBiblicaIdml([
      paragraph("p-c", "%24ID%2fNormalParagraphStyle", run("$ID/[No character style]", "Study Bible")),
    ]))
    expect(isBiblicaFrontBackMatterPackage(cover.units)).toBe(true)
  })

  it("imports every text-bearing paragraph of a front/back matter volume, grouped by heading", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml(biblicaFrontBackMatterStory))
    const selection = selectBiblicaStudyNotes(parsed.units, { frontBackMatter: true })

    expect(selection.notes.map((entry) => [entry.unit.sourceText, entry.section?.label])).toEqual([
      [FRONT_BACK_MATTER.title, FRONT_BACK_MATTER.title],
      [FRONT_BACK_MATTER.firstLetter, FRONT_BACK_MATTER.firstLetter],
      [FRONT_BACK_MATTER.firstEntry, FRONT_BACK_MATTER.firstLetter],
      [FRONT_BACK_MATTER.firstBody.join(""), FRONT_BACK_MATTER.firstLetter],
      [FRONT_BACK_MATTER.secondLetter, FRONT_BACK_MATTER.secondLetter],
      [FRONT_BACK_MATTER.secondEntry, FRONT_BACK_MATTER.secondLetter],
    ])
    // A volume with no chapters labels nothing by chapter, and belongs to no book.
    expect(selection.notes.every((entry) => (
      entry.chapterLabel === undefined && entry.bookCode === undefined
    ))).toBe(true)
    // Only the running head is left out — InDesign regenerates it from the layout.
    expect(selection.otherUnitCount).toBe(1)
    expect(selection.notes.map((entry) => entry.unit.sourceText))
      .not.toContain(FRONT_BACK_MATTER.runningHead)
  })

  it("opens a section at the title page and at the contents, so nothing hangs before the first heading", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-t", "title%3amt1", run("$ID/[No character style]", "HOLY BIBLE")),
      layoutText("p-c", "Copyright \u00a9 2025 by Biblica, Inc.", "text%3apc"),
      paragraph("p-toc", "toc%3atoc_hd", run("$ID/[No character style]", "Contents")),
      layoutText("p-g", "Genesis 6", "toc%3aTOC body text"),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units, { frontBackMatter: true })

    expect(selection.notes.map((entry) => entry.section?.label))
      .toEqual(["HOLY BIBLE", "HOLY BIBLE", "Contents", "Contents"])
  })

  it("reads a heading InDesign broke over several lines as one label", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      noteList("p-h", ["The Drama of the Bible:", "a visual chronology"], "intro%3aimt2"),
      layoutText("p-1", "Act 1 begins in a garden."),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units, { frontBackMatter: true })

    // Each line is its own cell, but the label reads as the heading was set —
    // without the space the two lines would run together into one word.
    expect(selection.notes.map((entry) => entry.unit.sourceText))
      .toEqual(["The Drama of the Bible:", "a visual chronology", "Act 1 begins in a garden."])
    expect(selection.notes.every((entry) => (
      entry.section?.label === "The Drama of the Bible: a visual chronology"
    ))).toBe(true)
  })

  it("keeps two sections with the same heading apart", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml([
      paragraph("p-a", "head%3ams1", run("$ID/[No character style]", "A")),
      paragraph("p-a1", "text%3am", run("$ID/[No character style]", "The first A entry.")),
      paragraph("p-b", "head%3ams1", run("$ID/[No character style]", "A")),
      paragraph("p-b1", "text%3am", run("$ID/[No character style]", "The second A entry.")),
    ]))
    const selection = selectBiblicaStudyNotes(parsed.units, { frontBackMatter: true })

    const ids = selection.notes.map((entry) => entry.section?.id)
    expect(new Set(ids).size).toBe(2)
    expect(selection.notes.every((entry) => entry.section?.label === "A")).toBe(true)
  })

  it("reads an apostrophe slot as text in front/back matter and as glue in a book volume", () => {
    const apostrophe = [
      syntheticUnit("ParagraphStyle/intro%3aip", [["\u02BC", "CharacterStyle/source serif"]], 0),
    ]

    // In a book volume that slot is InDesign glue, so the paragraph holds no
    // words of its own. In prose-heavy front/back matter it is a possessive.
    expect(selectBiblicaStudyNotes(apostrophe).notes).toEqual([])
    expect(selectBiblicaStudyNotes(apostrophe, { frontBackMatter: true }).notes)
      .toHaveLength(1)
  })

  it("returns nothing for a package with no note paragraphs", async () => {
    const parsed = await parseIdml(await makeBiblicaIdml(
      biblicaSampleStory.filter((block) =>
        !block.includes("intro%3a") && !block.includes("head%3acl"),
      ),
    ))
    const selection = selectBiblicaStudyNotes(parsed.units)

    expect(selection.notes).toEqual([])
    expect(selection.verseUnitCount).toBeGreaterThan(0)
  })
})
