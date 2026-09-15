import { describe, expect, it } from "vitest"
import { parseIdml } from "@aquilla/idml-roundtrip"
import {
  SAMPLE_EBL,
  lineList,
  makeEblIdml,
  styled,
  type EblIdmlStories,
} from "./__fixtures__/ebl-idml"
import { selectEblNotes } from "./notes"

async function selectFrom(stories: EblIdmlStories = {}, splitSentences = false) {
  const parsed = await parseIdml(await makeEblIdml(stories))
  return selectEblNotes(parsed.units, { splitSentences })
}

/** The same, for a guide shipped without any of the loose pull-out frames. */
function selectBody(body: readonly string[], splitSentences = false) {
  return selectFrom({ body, badge: [], summary: [] }, splitSentences)
}

/** The division label each cell landed under, in document order. */
function placement(notes: Awaited<ReturnType<typeof selectFrom>>["notes"]) {
  return notes.map((note) => [note.unit.sourceText, note.division?.label ?? ""])
}

describe("selectEblNotes — the guide's outline", () => {
  it("divides the guide by its own headings, naming each division after one", async () => {
    const { divisions } = await selectFrom()

    expect(divisions.map((division) => [division.kind, division.shortLabel, division.label]))
      .toEqual([
        // The loose frames the package lists ahead of the guide.
        ["boxes", "B", "Boxes and tables"],
        // Front matter, one division per level-1 heading.
        ["section", "1", "Facilitator Guide Module 1"],
        ["section", "2", SAMPLE_EBL.introHead],
        ["section", "3", SAMPLE_EBL.contentsHead],
        ["section", "4", "MODULE 1 How we have the Bible"],
        // A topic and its lessons.
        ["topic", "1.1", "Topic 1.1: How God shows himself"],
        ["lesson", "1.1.1", "Lesson 1: Seeing God from a distance"],
        ["lesson", "1.1.2", "Lesson 2: Seeing God up close"],
        // Back matter: a level-1 heading in the lesson group numbering no lesson.
        ["section", "5", SAMPLE_EBL.glossaryHead],
      ])
  })

  it("names a division from the whole heading when it is set over two lines", async () => {
    // A line break is a protected token rather than a newline, so the heading's
    // own text runs its lines together ("MODULE 1How we have the Bible"). Both
    // halves are needed: "MODULE 1" alone does not say which module.
    const { divisions } = await selectFrom()
    const module = divisions.find((division) => division.label.startsWith("MODULE"))

    expect(module?.label).toBe("MODULE 1 How we have the Bible")
  })

  it("gives every cell a division, in one unbroken run each", async () => {
    const { notes, divisions } = await selectFrom()

    expect(notes.every((note) => note.division)).toBe(true)
    // A division split across two runs would page as two disjoint ranges.
    const runs: string[] = []
    for (const note of notes) {
      if (runs.at(-1) !== note.division?.key) runs.push(note.division!.key)
    }
    expect(runs).toHaveLength(divisions.length)
    expect(new Set(runs).size).toBe(divisions.length)
  })

  it("places the front-matter body under the heading above it", async () => {
    const { notes } = await selectFrom()

    expect(placement(notes)).toContainEqual([SAMPLE_EBL.introBody, SAMPLE_EBL.introHead])
    expect(placement(notes)).toContainEqual([
      SAMPLE_EBL.topicBody,
      "Topic 1.1: How God shows himself",
    ])
    expect(placement(notes)).toContainEqual([
      SAMPLE_EBL.lessonTwoBody,
      "Lesson 2: Seeing God up close",
    ])
  })

  it("keeps a heading inside its division rather than opening a new one", async () => {
    const { notes } = await selectFrom()

    // A decorated level-2 heading in the topic group, and a level-5 heading in
    // the lesson group. Both title material within a division.
    expect(placement(notes)).toContainEqual([
      SAMPLE_EBL.materialsHead,
      "Topic 1.1: How God shows himself",
    ])
    expect(placement(notes)).toContainEqual([
      SAMPLE_EBL.bibleStudyHead,
      "Lesson 1: Seeing God from a distance",
    ])
  })

  it("files the cover line with the title page it introduces", async () => {
    // It is printed above the guide's first heading, so no division is open
    // yet — and it must not fall into the loose frames listed before it.
    const { notes } = await selectFrom()

    expect(notes[0]?.unit.sourceText).toBe(SAMPLE_EBL.summaryBanner)
    expect(placement(notes)).toContainEqual([
      SAMPLE_EBL.coverLine,
      "Facilitator Guide Module 1",
    ])
  })

  it("drops page furniture, table numbers and ruled write-in lines", async () => {
    const { notes, otherUnitCount } = await selectFrom()

    expect(notes.some((note) => note.unit.sourceText.includes("ACE"))).toBe(false)
    expect(notes.map((note) => note.unit.sourceText)).not.toContain(SAMPLE_EBL.tableNumber)
    expect(notes.map((note) => note.unit.sourceText)).not.toContain(SAMPLE_EBL.writeInRule)
    expect(notes.map((note) => note.unit.sourceText)).toContain(SAMPLE_EBL.writeInPrompt)
    // Two whole paragraphs (the table number and a standalone rule) plus the
    // ACE page-number frame the engine may omit entirely.
    expect(otherUnitCount).toBe(2)
  })
})

describe("selectEblNotes — loose frames", () => {
  it("does not let a timing badge open a division called '30 min'", async () => {
    // The badge is set in the same level-1 style a lesson tag uses. What tells
    // them apart is that the badge is the whole frame, with no body under it.
    const { notes, divisions } = await selectFrom()

    expect(divisions.map((division) => division.label)).not.toContain(SAMPLE_EBL.timingBadge)
    expect(placement(notes)).toContainEqual([SAMPLE_EBL.timingBadge, "Boxes and tables"])
    expect(placement(notes)).toContainEqual([SAMPLE_EBL.summaryBanner, "Boxes and tables"])
  })

  it("numbers the runs only when a package splits its loose frames", async () => {
    const { divisions } = await selectFrom()
    expect(divisions.filter((division) => division.kind === "boxes"))
      .toEqual([{ key: "ebl:boxes:1", kind: "boxes", label: "Boxes and tables", shortLabel: "B" }])
  })

  it("divides nothing when the package has no outline to read", async () => {
    // Every frame a loose one: there is no story where a heading is followed by
    // the body it heads. Calling the whole package "Boxes and tables" would say
    // less than the shared importer's own even parts, so it divides nothing.
    const { notes, divisions } = await selectFrom({ body: [] })

    expect(notes.map((note) => note.unit.sourceText))
      .toEqual([SAMPLE_EBL.summaryBanner, SAMPLE_EBL.timingBadge])
    expect(notes.every((note) => note.division === undefined)).toBe(true)
    expect(divisions).toEqual([])
  })
})

describe("selectEblNotes — cutting the text", () => {
  it("gives each line of a line-broken paragraph its own cell", async () => {
    // The template sets a contents block and a materials list as one paragraph
    // with a `<Br/>` between entries, which would otherwise be a single cell.
    const { notes } = await selectFrom()
    const texts = notes.map((note) => note.unit.sourceText)

    for (const entry of SAMPLE_EBL.contentsEntries) expect(texts).toContain(entry)
    for (const item of SAMPLE_EBL.materialsList) expect(texts).toContain(item)
    expect(texts).not.toContain(SAMPLE_EBL.contentsEntries.join(""))
  })

  it("keeps a long block whole when sentence splitting is off", async () => {
    const { notes } = await selectFrom({}, false)

    expect(notes.map((note) => note.unit.sourceText)).toContain(SAMPLE_EBL.lessonBlock)
    expect(notes.every((note) => note.rejoin === undefined)).toBe(true)
  })

  it("cuts a long block into one cell per sentence when asked, with rejoin ranges", async () => {
    const { notes } = await selectFrom({}, true)
    const block = notes.filter((note) => note.rejoin !== undefined)

    expect(block.map((note) => note.unit.sourceText))
      .toEqual([...SAMPLE_EBL.lessonBlockSentences])
    // Every slice of a line records its place, or the exporter cannot rebuild it.
    expect(block.map((note) => note.rejoin?.index)).toEqual([0, 1, 2])
    expect(block.every((note) => note.rejoin?.count === 3)).toBe(true)
    // Sentence cells stay in the division their line belongs to.
    expect(new Set(block.map((note) => note.division?.label)))
      .toEqual(new Set(["Lesson 1: Seeing God from a distance"]))
  })

  it("cuts a numbered step before its enumerator, never after it", async () => {
    // A facilitator guide sets numbered instructions as one paragraph. The cut
    // belongs after "…them.", so "2." opens the next cell; cutting after "2."
    // instead would strand the number on the end of the previous one.
    const steps = "1. Ask the group what they can see in the picture in front of them. "
      + "2. Read the passage aloud again while they look at it."
    const { notes } = await selectBody(
      [styled("b-steps", "07_Lessons:ms1", "Lesson 1"), styled("b-x", "07_Lessons:li2", steps)],
      true,
    )

    expect(notes.map((note) => note.unit.sourceText)).toEqual([
      "Lesson 1",
      "1. Ask the group what they can see in the picture in front of them. ",
      "2. Read the passage aloud again while they look at it.",
    ])
  })
})

describe("selectEblNotes — topics without the template's numbering", () => {
  it("names a topic from a tag that carries no number, plus its title", async () => {
    const { divisions } = await selectBody([
      styled("t-tag", "06_Lesson Intro:ms3", "Extra topic"),
      styled("t-title", "06_Lesson Intro:ms1", "How to keep going"),
      styled("t-body", "06_Lesson Intro:p", SAMPLE_EBL.topicBody),
    ])

    expect(divisions.map((division) => [division.kind, division.shortLabel, division.label]))
      .toEqual([["topic", "T1", "Extra topic: How to keep going"]])
  })

  it("opens a topic on a bare title when no tag precedes it", async () => {
    const { divisions } = await selectBody([
      styled("t-title", "06_Lesson Intro:ms1", "How to keep going"),
      styled("t-body", "06_Lesson Intro:p", SAMPLE_EBL.topicBody),
    ])

    expect(divisions.map((division) => [division.kind, division.shortLabel, division.label]))
      .toEqual([["topic", "T1", "How to keep going"]])
  })

  it("keeps lesson keys apart across topics that reuse 'Lesson 1'", async () => {
    const { divisions } = await selectBody([
      styled("a-tag", "06_Lesson Intro:ms3", "TOPIC 1.1"),
      styled("a-title", "06_Lesson Intro:ms1", "How God shows himself"),
      styled("a-l1", "07_Lessons:ms1", "Lesson 1"),
      styled("a-l1t", "07_Lessons:ms2", "Seeing God from a distance"),
      styled("a-l1b", "07_Lessons:p", SAMPLE_EBL.topicBody),
      styled("b-tag", "06_Lesson Intro:ms3", "TOPIC 1.2"),
      styled("b-title", "06_Lesson Intro:ms1", "How the Bible was inspired"),
      styled("b-l1", "07_Lessons:ms1", "Lesson 1"),
      styled("b-l1t", "07_Lessons:ms2", "Human writers of God's Word"),
      styled("b-l1b", "07_Lessons:p", SAMPLE_EBL.topicBody),
    ])

    const lessons = divisions.filter((division) => division.kind === "lesson")
    expect(lessons.map((lesson) => lesson.key))
      .toEqual(["ebl:lesson:1.1:1", "ebl:lesson:1.2:1"])
    expect(lessons.map((lesson) => lesson.shortLabel)).toEqual(["1.1.1", "1.2.1"])
  })

  it("only lets the line straight after a tag complete its title", async () => {
    // A stray level-2 heading later in the lesson must not rewrite the label.
    const { divisions } = await selectBody([
      styled("c-l1", "07_Lessons:ms1", "Lesson 1"),
      styled("c-l1t", "07_Lessons:ms2", "Seeing God from a distance"),
      styled("c-body", "07_Lessons:p", SAMPLE_EBL.topicBody),
      styled("c-stray", "07_Lessons:ms2", "In closing"),
    ])

    expect(divisions.map((division) => division.label))
      .toEqual(["Lesson 1: Seeing God from a distance"])
  })

  it("reads a heading set as one line-broken paragraph as a single heading", async () => {
    const { divisions } = await selectBody([
      lineList("d-title", "01_Intro page:ms1", ["Participant Guide", "Module 2"]),
      styled("d-body", "01_Intro page:m", SAMPLE_EBL.introBody),
    ])

    expect(divisions.map((division) => division.label)).toEqual(["Participant Guide Module 2"])
  })
})
