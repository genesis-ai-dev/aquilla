import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import {
  EBL_BODY_STORY_PATH,
  SAMPLE_EBL,
  makeEblIdml,
  styled,
  tocEntriesWithPageRuns,
  type EblIdmlStories,
} from "@/lib/biblica/ebl/__fixtures__/ebl-idml"
import { selectEblNotes } from "@/lib/biblica/ebl/notes"
import { extractEblStrings } from "./biblica-ebl"

async function extractFrom(stories: EblIdmlStories = {}) {
  const buffer = await makeEblIdml(stories)
  const parsed = await parseIdml(buffer)
  return { buffer, parsed, result: await extractEblStrings(buffer, async () => parsed) }
}

describe("EBL parser adapter", () => {
  it("maps every text-bearing paragraph to one protected IDML cell", async () => {
    const { result: { strings, skipped } } = await extractFrom()

    // Nothing is filtered out for being scripture: a guide is written material
    // throughout, and the passages it quotes are part of the teaching.
    expect(strings.map((cell) => cell.original)).toEqual([
      SAMPLE_EBL.summaryBanner,
      SAMPLE_EBL.timingBadge,
      SAMPLE_EBL.coverLine,
      ...SAMPLE_EBL.titleLines,
      SAMPLE_EBL.introHead,
      SAMPLE_EBL.introBody,
      SAMPLE_EBL.contentsHead,
      ...SAMPLE_EBL.contentsEntries,
      ...SAMPLE_EBL.moduleLines,
      SAMPLE_EBL.moduleBody,
      SAMPLE_EBL.topicTag,
      SAMPLE_EBL.topicTitle,
      SAMPLE_EBL.topicBody,
      SAMPLE_EBL.materialsHead,
      ...SAMPLE_EBL.materialsList,
      SAMPLE_EBL.lessonOneTag,
      SAMPLE_EBL.lessonOneTitle,
      ...SAMPLE_EBL.lessonBlockSentences,
      SAMPLE_EBL.bibleStudyHead,
      SAMPLE_EBL.bibleStudyBody,
      SAMPLE_EBL.lessonTwoTag,
      SAMPLE_EBL.lessonTwoTitle,
      SAMPLE_EBL.lessonTwoBody,
      SAMPLE_EBL.writeInPrompt,
      SAMPLE_EBL.glossaryHead,
      SAMPLE_EBL.glossaryBody,
    ])
    expect(strings.map((cell) => cell.original)).not.toContain(SAMPLE_EBL.tableNumber)
    expect(strings.map((cell) => cell.original)).not.toContain(SAMPLE_EBL.writeInRule)
    expect(skipped).toEqual({ otherUnitCount: 2 })

    for (const cell of strings) {
      expect(cell.type).toBe("text")
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.biblica).toMatchObject({ version: 1, edition: "ebl" })
    }
    expect(strings.find((cell) => cell.original === SAMPLE_EBL.introBody)?.sourceLocator)
      .toMatchObject({ kind: "idml", memberPath: EBL_BODY_STORY_PATH })
  })

  it("gives each cell the milestone of the division it belongs to", async () => {
    const { result: { strings } } = await extractFrom()
    const milestoneOf = (text: string) => (
      strings.find((cell) => cell.original === text)?.milestone
    )

    expect(milestoneOf(SAMPLE_EBL.topicBody)).toEqual({
      key: "ebl:topic:1.1",
      // Every division navigates as a section: a guide has no chapters.
      kind: "section",
      label: "Topic 1.1: How God shows himself",
      shortLabel: "1.1",
    })
    expect(milestoneOf(SAMPLE_EBL.bibleStudyBody)).toEqual({
      key: "ebl:lesson:1.1:1",
      kind: "section",
      label: "Lesson 1: Seeing God from a distance",
      shortLabel: "1.1.1",
    })
    expect(milestoneOf(SAMPLE_EBL.introBody)).toMatchObject({
      key: "ebl:section:2:introduction",
      label: SAMPLE_EBL.introHead,
    })
    // The label is also the cell's section, the way the other editions set it.
    expect(strings.find((cell) => cell.original === SAMPLE_EBL.topicBody)?.section)
      .toBe("Topic 1.1: How God shows himself")
  })

  it("shares one milestone across every cell of a division", async () => {
    const { result: { strings } } = await extractFrom()
    const lesson = strings.filter((cell) => cell.milestone?.key === "ebl:lesson:1.1:1")

    expect(lesson.map((cell) => cell.original)).toEqual([
      SAMPLE_EBL.lessonOneTag,
      SAMPLE_EBL.lessonOneTitle,
      ...SAMPLE_EBL.lessonBlockSentences,
      SAMPLE_EBL.bibleStudyHead,
      SAMPLE_EBL.bibleStudyBody,
    ])
  })

  it("records the division and paragraph style so a cell's role stays auditable", async () => {
    const { result: { strings } } = await extractFrom()
    const biblicaOf = (text: string) => (
      strings.find((cell) => cell.original === text)?.metadata?.biblica
    )

    expect(biblicaOf(SAMPLE_EBL.bibleStudyBody)).toEqual({
      version: 1,
      edition: "ebl",
      contentType: "lesson",
      sectionId: "ebl:lesson:1.1:1",
      sectionLabel: "Lesson 1: Seeing God from a distance",
      paragraphStyle: "ParagraphStyle/07_Lessons%3am_shade1",
    })
    expect(biblicaOf(SAMPLE_EBL.topicBody)).toMatchObject({ contentType: "topic-intro" })
    expect(biblicaOf(SAMPLE_EBL.introBody)).toMatchObject({ contentType: "section" })
    expect(biblicaOf(SAMPLE_EBL.timingBadge)).toMatchObject({ contentType: "boxes" })
  })

  it("leaves the milestone off when the package has no outline to read", async () => {
    // The shared importer then divides the file into its own even parts, which
    // says more than one division named after the loose frames it is made of.
    const { result: { strings } } = await extractFrom({ body: [] })

    expect(strings.map((cell) => cell.original))
      .toEqual([SAMPLE_EBL.summaryBanner, SAMPLE_EBL.timingBadge])
    expect(strings.every((cell) => cell.milestone === undefined)).toBe(true)
    expect(strings.every((cell) => cell.section === undefined)).toBe(true)
    expect(strings[0]?.metadata?.biblica).toEqual({
      version: 1,
      edition: "ebl",
      paragraphStyle: "ParagraphStyle/07_Lessons%3atest summary header",
    })
  })

  it("carries the rejoin ranges only on cells that are part of a sliced block", async () => {
    const { result: { strings } } = await extractFrom()

    const sentences = strings.filter((cell) => (
      SAMPLE_EBL.lessonBlockSentences.some((sentence) => cell.original === sentence)
    ))
    expect(sentences).toHaveLength(3)
    expect(sentences.map((cell) => cell.metadata?.idmlRejoin)).toEqual([
      { version: 1, index: 0, count: 3, ranges: [expect.objectContaining({ slot: 0, start: 0 })] },
      { version: 1, index: 1, count: 3, ranges: [expect.any(Object)] },
      { version: 1, index: 2, count: 3, ranges: [expect.any(Object)] },
    ])
    for (const cell of strings.filter((candidate) => !sentences.includes(candidate))) {
      expect(cell.metadata?.idmlRejoin).toBeUndefined()
    }
  })

  it("keeps a teaching block whole when sentence splitting is turned off", async () => {
    const buffer = await makeEblIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractEblStrings(buffer, async () => parsed, {
      splitSentences: false,
    })

    expect(strings.map((cell) => cell.original)).toContain(SAMPLE_EBL.lessonBlock)
    expect(strings.some((cell) => (
      cell.original === SAMPLE_EBL.lessonBlockSentences[0]
    ))).toBe(false)
    expect(strings.every((cell) => cell.metadata?.idmlRejoin === undefined)).toBe(true)
  })

  it("keeps every cell's identity and protected anchors identical to its selected unit", async () => {
    const { parsed, result: { strings } } = await extractFrom()
    const { notes } = selectEblNotes(parsed.units)

    expect(strings).toHaveLength(notes.length)
    expect(new Set(strings.map((cell) => cell.id)).size).toBe(strings.length)
    for (const [index, cell] of strings.entries()) {
      const unit = notes[index]!.unit
      expect(cell.id).toBe(unit.id)
      expect(cell.originalHtml).toBe(unit.sourceHtml)
      expect(cell.sourceLocator).toEqual(unit.locator)

      // A cell is either a whole paragraph or one of its lines, so its locator
      // always addresses slots of a paragraph the engine parsed — that is what
      // a strict export needs to place the translation back.
      // Scoped by member: a guide is several stories, and an element path is
      // only unique within the one it indexes.
      const paragraphUnit = parsed.units.find((candidate) => (
        candidate.locator.memberPath === unit.locator.memberPath
        && candidate.locator.elementPath === unit.locator.elementPath
      ))
      expect(paragraphUnit).toBeDefined()
      expect(unit.locator.sourceBlockHash).toBe(paragraphUnit!.locator.sourceBlockHash)
      expect(paragraphUnit!.locator.slotIndexes).toEqual(
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
    const buffer = await makeEblIdml()
    const parsed = await parseIdml(buffer)
    const parse = vi.fn(async () => parsed)
    const controller = new AbortController()
    const onProgress = vi.fn()

    await extractEblStrings(buffer, parse, { signal: controller.signal, onProgress })

    // Selection happens here, after the engine has parsed every literal location.
    expect(parse).toHaveBeenCalledWith(buffer, "generic", {
      signal: controller.signal,
      onProgress,
    })
  })

  it("returns no cells for a package holding only page furniture", async () => {
    const { result: { strings } } = await extractFrom({
      body: [styled("f-page", "*Page number", "12")],
      badge: [],
      summary: [],
    })

    expect(strings).toEqual([])
  })

  it("omits contents page numbers from the imported original", async () => {
    const entries = SAMPLE_EBL.contentsTitles.map((title, index) => ({
      title,
      page: SAMPLE_EBL.contentsPages[index]!,
    }))
    const { result: { strings } } = await extractFrom({
      body: [
        styled("h", "02_TOC:ms1", SAMPLE_EBL.contentsHead),
        tocEntriesWithPageRuns("toc", "02_TOC:tc1", entries),
        styled("nested", "02_TOC:tc3", SAMPLE_EBL.contentsNestedEntry),
      ],
      badge: [],
      summary: [],
    })
    const originals = strings.map((cell) => cell.original)

    for (const title of SAMPLE_EBL.contentsTitles) expect(originals).toContain(title)
    expect(originals).toContain(SAMPLE_EBL.contentsNestedTitle)
    for (const page of SAMPLE_EBL.contentsPages) expect(originals).not.toContain(page)
    expect(originals).not.toContain(SAMPLE_EBL.contentsNestedEntry)
    expect(originals.some((text) => text.includes(SAMPLE_EBL.contentsNestedPage))).toBe(false)
  })
})
