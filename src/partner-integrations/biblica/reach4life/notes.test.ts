import { describe, expect, it } from "vitest"
import { parseIdml } from "@aquilla/idml-roundtrip"
import {
  SAMPLE_REACH4LIFE,
  lineList,
  makeReach4LifeIdml,
  reach4LifeWorkbookSampleStory,
  scripture,
  styled,
} from "./__fixtures__/reach4life-idml"
import { classifyReach4LifeUnit } from "./note-rules"
import { selectReach4LifeNotes } from "./notes"

async function selectFrom(paragraphs?: readonly string[], splitSentences = true) {
  const parsed = await parseIdml(await makeReach4LifeIdml(paragraphs))
  return selectReach4LifeNotes(parsed.units, { splitSentences })
}

describe("selectReach4LifeNotes — scripture volume", () => {
  it("imports the introductions and matter around the text and none of the text", async () => {
    const { notes, scriptureUnitCount, otherUnitCount } = await selectFrom()

    expect(notes.map((entry) => [
      entry.unit.sourceText,
      entry.bookCode ?? "",
      entry.section.label,
      entry.contentType,
    ])).toEqual([
      // The strapline sits above the title of the book it opens, so it is
      // claimed for that book rather than left unplaced.
      [SAMPLE_REACH4LIFE.bookStrapline, "MAT", "Book introductions", "book-intro"],
      [SAMPLE_REACH4LIFE.bookTitle, "MAT", "Book introductions", "book-intro"],
      [SAMPLE_REACH4LIFE.bookIntroHead, "MAT", "Book introductions", "book-intro"],
      [SAMPLE_REACH4LIFE.bookIntroBody, "MAT", "Book introductions", "book-intro"],
      // The next book's strapline must not stay with the previous book.
      [SAMPLE_REACH4LIFE.bookStrapline, "MRK", "Book introductions", "book-intro"],
      [SAMPLE_REACH4LIFE.secondBookTitle, "MRK", "Book introductions", "book-intro"],
      [SAMPLE_REACH4LIFE.secondBookIntroHead, "MRK", "Book introductions", "book-intro"],
      [SAMPLE_REACH4LIFE.copyright, "", "Copyright", "front-matter"],
      // The contents block is one InDesign paragraph; each entry gets a cell.
      [SAMPLE_REACH4LIFE.contentsEntries[0], "", "Contents", "front-matter"],
      [SAMPLE_REACH4LIFE.contentsEntries[1], "", "Contents", "front-matter"],
      [SAMPLE_REACH4LIFE.contentsEntries[2], "", "Contents", "front-matter"],
      [SAMPLE_REACH4LIFE.readingGuideHead, "", "Introduction", "front-matter"],
      [SAMPLE_REACH4LIFE.readingGuide, "", "Introduction", "front-matter"],
    ])

    // The book title, the section heading, the verse paragraph and the poetry.
    expect(scriptureUnitCount).toBe(4)
    // The running head and the TOC marker. The page-element frame holds only an
    // ACE marker, which is a processing instruction rather than text, so the
    // engine reports no unit for it at all.
    expect(otherUnitCount).toBe(2)
  })

  it("never emits a cell that originated in a scripture paragraph", async () => {
    const { notes } = await selectFrom()

    // The book title "Matthew" is set both as scripture (`Titles:mt1`) and as
    // the introduction's own title, so the invariant worth asserting is the
    // style each cell came from rather than its words.
    for (const entry of notes) {
      expect(classifyReach4LifeUnit(entry.unit.paragraphStyleId ?? "")).toBe("content")
    }
    expect(notes.map((entry) => entry.unit.sourceText))
      .not.toContain(SAMPLE_REACH4LIFE.scriptureBody)
    expect(notes.map((entry) => entry.unit.sourceText))
      .not.toContain(SAMPLE_REACH4LIFE.scriptureVerse)
  })

  it("leaves front matter unattached to a book it does not belong to", async () => {
    const { notes } = await selectFrom([
      styled("p-copy", "Copyright:pc", SAMPLE_REACH4LIFE.copyright),
      styled("p-imt1", "Metatext_BBI Bible Book Intros:imt1", SAMPLE_REACH4LIFE.bookTitle),
      styled("p-im", "Metatext_BBI Bible Book Intros:im", SAMPLE_REACH4LIFE.bookIntroBody),
    ])

    expect(notes.map((entry) => entry.bookCode ?? "")).toEqual(["", "MAT", "MAT"])
  })
})

describe("selectReach4LifeNotes — workbook section", () => {
  it("imports the lessons, including the verses they quote", async () => {
    const { notes, scriptureUnitCount, otherUnitCount } = await selectFrom(
      reach4LifeWorkbookSampleStory,
    )

    expect(notes.map((entry) => [entry.unit.sourceText, entry.section.label, entry.contentType]))
      .toEqual([
        [SAMPLE_REACH4LIFE.lessonTitle, "Who am I?", "lesson"],
        // The lesson block is one paragraph; each sentence gets its own cell.
        [SAMPLE_REACH4LIFE.lessonBlockSentences[0], "Who am I?", "lesson"],
        [SAMPLE_REACH4LIFE.lessonBlockSentences[1], "Who am I?", "lesson"],
        [SAMPLE_REACH4LIFE.lessonBlockSentences[2], "Who am I?", "lesson"],
        // A verse quoted inside the lesson stays with the lesson, as does the
        // reference caption printed under it.
        [SAMPLE_REACH4LIFE.lessonQuote, "Who am I?", "lesson"],
        [SAMPLE_REACH4LIFE.lessonQuoteRef, "Who am I?", "lesson"],
        [SAMPLE_REACH4LIFE.storyTitle, "The story", "lesson"],
        [SAMPLE_REACH4LIFE.storyBody, "The story", "lesson"],
        // The Reach4Life heading that introduces a psalm reading is copy; the
        // psalm itself is not.
        [SAMPLE_REACH4LIFE.psalmHeading, "Psalms", "lesson"],
      ])

    // The psalm superscription and the psalm line.
    expect(scriptureUnitCount).toBe(2)
    // The running head and the typesetter's note.
    expect(otherUnitCount).toBe(2)
  })

  it("gives a lesson no book, even when it quotes one", async () => {
    const { notes } = await selectFrom(reach4LifeWorkbookSampleStory)

    expect(notes.every((entry) => entry.bookCode === undefined)).toBe(true)
  })

  it("keeps each line of a bullet list as its own cell", async () => {
    const bullets = [
      "Make a decision to wait. Every new direction starts with a simple choice.",
      "Do not fill your mind with sex. Cut out sexually-charged music and movies.",
    ] as const
    const { notes } = await selectFrom(
      [lineList("w-li", "R4Lv4 Paragraph Styles:9_SIE:li4", bullets)],
      false,
    )

    expect(notes.map((entry) => entry.unit.sourceText)).toEqual([...bullets])
  })
})

describe("selectReach4LifeNotes — sentence splitting", () => {
  it("keeps a paragraph whole when splitting is off", async () => {
    const { notes } = await selectFrom(reach4LifeWorkbookSampleStory, false)

    expect(notes.map((entry) => entry.unit.sourceText))
      .toContain(SAMPLE_REACH4LIFE.lessonBlock)
    expect(notes.every((entry) => entry.rejoin === undefined)).toBe(true)
  })

  it("carries rejoin ranges that tile the line the slices came from", async () => {
    const { notes } = await selectFrom(reach4LifeWorkbookSampleStory)

    const slices = notes.filter((entry) => entry.rejoin !== undefined)
    expect(slices).toHaveLength(SAMPLE_REACH4LIFE.lessonBlockSentences.length)
    expect(slices.map((entry) => entry.rejoin!.index)).toEqual([0, 1, 2])
    expect(slices.every((entry) => entry.rejoin!.count === 3)).toBe(true)
    // The ranges have to tile the paragraph end to end, or the exporter cannot
    // rebuild the line the slices came from.
    const ranges = slices.flatMap((entry) => entry.rejoin!.ranges)
    expect(ranges[0]!.start).toBe(0)
    expect(ranges.at(-1)!.end).toBe(SAMPLE_REACH4LIFE.lessonBlock.length)
    for (const [index, range] of ranges.slice(1).entries()) {
      expect(range.start).toBe(ranges[index]!.end)
    }
  })

  it("does not cut after the number that opens an enumerated step", async () => {
    // Reach4Life sets numbered advice as one paragraph, so a cut after "2."
    // would strand the enumerator on the end of the previous cell.
    const enumerated = "1. Listen to them without judging. This is how we show we care. "
      + "2. Watch for the signs that someone close to you is struggling badly."
    const { notes } = await selectFrom(
      [styled("w-li", "R4Lv4 Paragraph Styles:10_HOT Hot Topics:li2", enumerated)],
    )

    for (const entry of notes) {
      expect(entry.unit.sourceText.trimEnd()).not.toMatch(/\d\.$/)
    }
  })
})

describe("selectReach4LifeNotes — counting", () => {
  it("counts every scripture paragraph it skipped", async () => {
    const { notes, scriptureUnitCount } = await selectFrom([
      scripture("p-v1", SAMPLE_REACH4LIFE.scriptureBody, { chapter: "1", verse: "1" }),
      scripture("p-v2", "Abraham was the father of Isaac.", {
        style: "Paragraphs:List items:li1",
      }),
      styled("p-q1", "Poetry:q2", SAMPLE_REACH4LIFE.scriptureVerse),
      styled("p-guide", "Intros:im", SAMPLE_REACH4LIFE.readingGuide),
    ])

    expect(scriptureUnitCount).toBe(3)
    expect(notes.map((entry) => entry.unit.sourceText))
      .toEqual([SAMPLE_REACH4LIFE.readingGuide])
  })

  it("skips a package that is scripture and furniture only", async () => {
    const { notes, scriptureUnitCount, otherUnitCount } = await selectFrom([
      scripture("p-v1", SAMPLE_REACH4LIFE.scriptureBody, { chapter: "1", verse: "1" }),
      styled("p-rh", "Page Elements:h", "Matthew"),
    ])

    expect(notes).toEqual([])
    expect(scriptureUnitCount).toBe(1)
    expect(otherUnitCount).toBe(1)
  })
})
