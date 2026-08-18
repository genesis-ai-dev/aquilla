import { describe, expect, it } from "vitest"
import { parseIdml } from "@aquilla/idml-roundtrip"
import {
  SAMPLE_TREASURE_HUNT,
  blockHead,
  makeTreasureHuntIdml,
  note,
  noteList,
  paragraph,
  run,
  scripture,
  sectionHead,
} from "./__fixtures__/treasure-hunt-idml"
import { classifyTreasureHuntUnit } from "./note-rules"
import { selectTreasureHuntNotes } from "./notes"

const PLAIN = "$ID/[No character style]"

async function selectFrom(paragraphs?: readonly string[], splitSentences = true) {
  const parsed = await parseIdml(await makeTreasureHuntIdml(paragraphs))
  return selectTreasureHuntNotes(parsed.units, { splitSentences })
}

describe("selectTreasureHuntNotes", () => {
  it("imports everything set around the Bible text and nothing of the text itself", async () => {
    const { notes, scriptureUnitCount, otherUnitCount } = await selectFrom()

    expect(notes.map((entry) => [entry.unit.sourceText, entry.chapterLabel, entry.contentType]))
      .toEqual([
        [SAMPLE_TREASURE_HUNT.frontMatterTitle, "Intro", "front-matter"],
        [SAMPLE_TREASURE_HUNT.frontMatter, "Intro", "front-matter"],
        // The section heading is set above the title of the book it opens.
        [SAMPLE_TREASURE_HUNT.introSection, "Intro", "intro"],
        [SAMPLE_TREASURE_HUNT.introBook, "Intro", "intro"],
        [SAMPLE_TREASURE_HUNT.introHead, "Intro", "intro"],
        // The intro list is one paragraph in InDesign; each line gets its own cell.
        [SAMPLE_TREASURE_HUNT.introList[0], "Intro", "intro"],
        [SAMPLE_TREASURE_HUNT.introList[1], "Intro", "intro"],
        [SAMPLE_TREASURE_HUNT.factHead, "1", "hunt"],
        // The fact block is one paragraph; each sentence gets its own cell.
        [SAMPLE_TREASURE_HUNT.factBlockSentences[0], "1", "hunt"],
        [SAMPLE_TREASURE_HUNT.factBlockSentences[1], "1", "hunt"],
        [SAMPLE_TREASURE_HUNT.factBlockSentences[2], "1", "hunt"],
        [SAMPLE_TREASURE_HUNT.huntHead, "3", "hunt"],
        [SAMPLE_TREASURE_HUNT.huntNote, "3", "hunt"],
        [SAMPLE_TREASURE_HUNT.huntSteps[0], "3", "hunt"],
        [SAMPLE_TREASURE_HUNT.huntSteps[1], "3", "hunt"],
        [SAMPLE_TREASURE_HUNT.rangeHead, "1-3", "hunt"],
        ["Read these chapters and draw what you find.", "1-3", "hunt"],
      ])

    // The book title, the section head and the verse paragraph.
    expect(scriptureUnitCount).toBe(3)
    // The running head and the proof stamp. The page number holds only an ACE
    // marker, which is a processing instruction rather than text, so the engine
    // reports no unit for it at all.
    expect(otherUnitCount).toBe(2)
  })

  it("never emits the published Bible text, whatever it says", async () => {
    const { notes } = await selectFrom()

    expect(notes.map((entry) => entry.unit.sourceText)).not.toContain(
      SAMPLE_TREASURE_HUNT.scriptureBody,
    )
    // The scripture head reads "The Beginning" and the book title "Genesis" —
    // the latter is also the introduction's book name, which *is* imported. So
    // the invariant worth asserting is the style each cell came from, not its
    // words: no cell may originate in a scripture paragraph.
    for (const entry of notes) {
      expect(entry.unit.paragraphStyleId).toBeDefined()
      expect(classifyTreasureHuntUnit(entry.unit.paragraphStyleId!)).toBe("content")
    }
    expect(notes.filter((entry) => entry.unit.sourceText === "Genesis")).toHaveLength(1)
  })

  it("carries the book forward from the heading that named it", async () => {
    const { notes } = await selectFrom()

    // Front matter precedes any book, so it has none.
    expect(notes[0]!.bookCode).toBeUndefined()
    expect(notes[1]!.bookCode).toBeUndefined()
    // The `_intro_book_long` paragraph opens Genesis for the introduction, and
    // claims the section heading set above it.
    expect(notes[2]!.bookCode).toBe("GEN")
    expect(notes[3]!.bookCode).toBe("GEN")
    expect(notes.at(-1)!.bookCode).toBe("GEN")
  })

  it("gives the section heading above a book title to the book it opens", async () => {
    // Real volumes set the section heading before the title, and carry the
    // other books' thumb-tab labels ahead of both, so the book in effect when
    // the heading arrives is the wrong one.
    const { notes } = await selectFrom([
      paragraph("tab1", "_intro_book", run(PLAIN, "Exodus")),
      paragraph("sec", "_intro_section", run(PLAIN, SAMPLE_TREASURE_HUNT.introSection)),
      paragraph("title", "_intro_book_long", run(PLAIN, "Genesis")),
      paragraph("head", "_intro_head", run(PLAIN, SAMPLE_TREASURE_HUNT.introHead)),
    ])

    expect(notes.map((entry) => [entry.unit.sourceText, entry.bookCode])).toEqual([
      ["Exodus", "EXO"],
      [SAMPLE_TREASURE_HUNT.introSection, "GEN"],
      ["Genesis", "GEN"],
      [SAMPLE_TREASURE_HUNT.introHead, "GEN"],
    ])
  })

  it("does not reach back past notes that already belong to a chapter", async () => {
    const { notes } = await selectFrom([
      blockHead("h1", "Exodus 20:1\u201317"),
      note("n1", "The Lord gave Moses ten commandments."),
      paragraph("sec", "_intro_section", run(PLAIN, SAMPLE_TREASURE_HUNT.introSection)),
      paragraph("title", "_intro_book_long", run(PLAIN, "Leviticus")),
    ])

    expect(notes.map((entry) => [entry.bookCode, entry.chapterLabel])).toEqual([
      ["EXO", "20"],
      ["EXO", "20"],
      ["LEV", "Intro"],
      ["LEV", "Intro"],
    ])
  })

  it("re-anchors on each fact and hunt heading, including across books", async () => {
    const { notes } = await selectFrom([
      blockHead("h1", "Matthew 5:1\u201312"),
      note("n1", "Jesus went up a mountain."),
      blockHead("h2", "Acts 2", true),
      note("n2", "The Spirit came at Pentecost."),
    ])

    expect(notes.map((entry) => [entry.bookCode, entry.chapterLabel])).toEqual([
      ["MAT", "5"],
      ["MAT", "5"],
      ["ACT", "2"],
      ["ACT", "2"],
    ])
  })

  it("keeps the previous reference when a heading names a topic rather than a passage", async () => {
    const { notes } = await selectFrom([
      blockHead("h1", "Galatians 1:6\u20139"),
      note("n1", "Paul is upset with these churches."),
      blockHead("h2", "Galatia"),
      note("n2", "Galatia was a Roman province."),
    ])

    expect(notes.map((entry) => [entry.bookCode, entry.chapterLabel])).toEqual([
      ["GAL", "1"],
      ["GAL", "1"],
      ["GAL", "1"],
      ["GAL", "1"],
    ])
  })

  it("keeps each line of a list as its own cell", async () => {
    const { notes } = await selectFrom([
      noteList("l1", ["First step.", "Second step.", "Third step."]),
    ])

    expect(notes.map((entry) => entry.unit.sourceText))
      .toEqual(["First step.", "Second step.", "Third step."])
    // Line parts are real locators, so they need no rejoin bucket.
    expect(notes.every((entry) => entry.rejoin === undefined)).toBe(true)
  })

  it("keeps a block whole when sentence splitting is off, lists included", async () => {
    const { notes } = await selectFrom(undefined, false)
    const imported = notes.map((entry) => entry.unit.sourceText)

    expect(imported).toContain(SAMPLE_TREASURE_HUNT.factBlock)
    expect(imported).not.toContain(SAMPLE_TREASURE_HUNT.factBlockSentences[0])
    // Lists still split per line either way.
    expect(imported).toContain(SAMPLE_TREASURE_HUNT.huntSteps[0])
    expect(notes.every((entry) => entry.rejoin === undefined)).toBe(true)
  })

  it("tiles a sliced line with rejoin ranges so the exporter can rebuild it", async () => {
    const { notes } = await selectFrom()
    const sentences = notes.filter((entry) => (
      SAMPLE_TREASURE_HUNT.factBlockSentences.some((text) => entry.unit.sourceText === text)
    ))

    expect(sentences).toHaveLength(3)
    expect(sentences.map((entry) => entry.rejoin?.index)).toEqual([0, 1, 2])
    expect(sentences.every((entry) => entry.rejoin?.count === 3)).toBe(true)
    for (const entry of notes.filter((candidate) => !sentences.includes(candidate))) {
      expect(entry.rejoin).toBeUndefined()
    }
  })

  it("skips a content-styled paragraph that holds only page furniture", async () => {
    const { notes, otherUnitCount } = await selectFrom([
      // Some volumes set the running-head separator in a content style.
      paragraph("f1", "!meta_par", run(PLAIN, " | ")),
      paragraph("f2", "!meta_par", run(PLAIN, "   ")),
      note("n1", "A real note that must survive."),
    ])

    expect(notes.map((entry) => entry.unit.sourceText)).toEqual(["A real note that must survive."])
    // The whitespace-only paragraph carries no text for the engine to report,
    // so only the separator reaches the filter.
    expect(otherUnitCount).toBe(1)
  })

  it("returns nothing for a package that is scripture and furniture only", async () => {
    const { notes, scriptureUnitCount } = await selectFrom([
      sectionHead("s1", "The Beginning"),
      scripture("v1", "In the beginning, God created the heavens and the earth.", {
        chapter: "1",
        verse: "1",
      }),
      paragraph("pn", "#pn", run(PLAIN, "<?ACE 18?>")),
    ])

    expect(notes).toEqual([])
    expect(scriptureUnitCount).toBe(2)
  })
})
