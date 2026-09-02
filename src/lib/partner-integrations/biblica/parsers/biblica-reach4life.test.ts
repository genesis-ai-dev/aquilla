import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import {
  REACH4LIFE_STORY_PATH,
  SAMPLE_REACH4LIFE,
  makeReach4LifeIdml,
  reach4LifeWorkbookSampleStory,
  scripture,
  styled,
} from "@/lib/partner-integrations/biblica/reach4life/__fixtures__/reach4life-idml"
import { selectReach4LifeNotes } from "@/lib/partner-integrations/biblica/reach4life/notes"
import { extractReach4LifeStrings } from "./biblica-reach4life"

async function extractFrom(paragraphs?: readonly string[]) {
  const buffer = await makeReach4LifeIdml(paragraphs)
  const parsed = await parseIdml(buffer)
  return { buffer, parsed, result: await extractReach4LifeStrings(buffer, async () => parsed) }
}

describe("Reach 4 Life parser adapter", () => {
  it("maps each selected paragraph to one protected IDML cell in its section", async () => {
    const { result: { strings, bookCodes, skipped } } = await extractFrom()

    expect(strings.map((cell) => [cell.original, cell.section])).toEqual([
      [SAMPLE_REACH4LIFE.bookStrapline, "Matthew introduction"],
      [SAMPLE_REACH4LIFE.bookTitle, "Matthew introduction"],
      [SAMPLE_REACH4LIFE.bookIntroHead, "Matthew introduction"],
      [SAMPLE_REACH4LIFE.bookIntroBody, "Matthew introduction"],
      [SAMPLE_REACH4LIFE.bookStrapline, "Mark introduction"],
      [SAMPLE_REACH4LIFE.secondBookTitle, "Mark introduction"],
      [SAMPLE_REACH4LIFE.secondBookIntroHead, "Mark introduction"],
      [SAMPLE_REACH4LIFE.copyright, "Copyright"],
      [SAMPLE_REACH4LIFE.contentsEntries[0], "Contents"],
      [SAMPLE_REACH4LIFE.contentsEntries[1], "Contents"],
      [SAMPLE_REACH4LIFE.contentsEntries[2], "Contents"],
      [SAMPLE_REACH4LIFE.readingGuideHead, "Introduction"],
      [SAMPLE_REACH4LIFE.readingGuide, "Introduction"],
    ])
    expect(bookCodes).toEqual(["MAT", "MRK"])
    expect(skipped).toEqual({ scriptureUnitCount: 4, otherUnitCount: 2 })

    for (const cell of strings) {
      expect(cell.type).toBe("text")
      expect(cell.sourceLocator).toMatchObject({
        kind: "idml",
        memberPath: REACH4LIFE_STORY_PATH,
      })
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.biblica).toMatchObject({ version: 1, edition: "reach4life" })
    }
  })

  it("gives a book introduction a milestone under its book, badged with the code", async () => {
    const { result: { strings } } = await extractFrom()

    expect(strings[0]!.milestone).toEqual({
      key: "reach4life:book:MAT",
      kind: "preface",
      label: "Matthew introduction",
      shortLabel: "MAT",
    })
    expect(strings[4]!.milestone).toMatchObject({ key: "reach4life:book:MRK" })
    // Every paragraph of one introduction shares its milestone, so the
    // navigator moves a book at a time.
    expect(strings.slice(0, 4).map((cell) => cell.milestone?.key))
      .toEqual(Array(4).fill("reach4life:book:MAT"))
  })

  it("gives every other section a milestone of its own, numbered as it appears", async () => {
    const { result: { strings } } = await extractFrom(reach4LifeWorkbookSampleStory)

    expect(strings.map((cell) => cell.milestone).filter((milestone, index, all) => (
      all.findIndex((candidate) => candidate?.key === milestone?.key) === index
    ))).toEqual([
      { key: "reach4life:section:wai", kind: "section", label: "Who am I?", shortLabel: "1" },
      { key: "reach4life:section:story", kind: "section", label: "The story", shortLabel: "2" },
      { key: "reach4life:section:psalms", kind: "section", label: "Psalms", shortLabel: "3" },
    ])
  })

  it("tags each cell with the part of the edition it came from", async () => {
    const { result: { strings } } = await extractFrom()
    const workbook = await extractFrom(reach4LifeWorkbookSampleStory)

    const contentTypeOf = (cells: typeof strings, text: string) => {
      const cell = cells.find((candidate) => candidate.original === text)
      return (cell?.metadata?.biblica as { contentType?: string } | undefined)?.contentType
    }
    expect(contentTypeOf(strings, SAMPLE_REACH4LIFE.bookIntroBody)).toBe("book-intro")
    expect(contentTypeOf(strings, SAMPLE_REACH4LIFE.copyright)).toBe("front-matter")
    expect(contentTypeOf(workbook.result.strings, SAMPLE_REACH4LIFE.storyBody)).toBe("lesson")

    // The paragraph style is retained so a cell's role stays auditable later.
    expect(strings[3]!.metadata?.biblica).toMatchObject({
      paragraphStyle: "ParagraphStyle/Metatext_BBI Bible Book Intros%3aim",
      sectionId: "bbi bible book intros",
      sectionLabel: "Book introductions",
    })
  })

  it("references a book only from the introduction that is about it", async () => {
    const { result: { strings } } = await extractFrom()
    const workbook = await extractFrom(reach4LifeWorkbookSampleStory)

    expect(strings[0]!.globalReferences).toEqual(["MAT"])
    expect(strings[4]!.globalReferences).toEqual(["MRK"])
    expect(strings.at(-1)!.globalReferences).toBeUndefined()
    // A lesson quotes Genesis but is not about Genesis.
    expect(workbook.result.strings.every((cell) => cell.globalReferences === undefined))
      .toBe(true)
    expect(workbook.result.bookCodes).toEqual([])
  })

  it("carries the rejoin ranges only on cells that are part of a sliced block", async () => {
    const { result: { strings } } = await extractFrom(reach4LifeWorkbookSampleStory)

    const sentences = strings.filter((cell) => (
      SAMPLE_REACH4LIFE.lessonBlockSentences.some((sentence) => cell.original === sentence)
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

  it("keeps a lesson block whole when sentence splitting is turned off", async () => {
    const buffer = await makeReach4LifeIdml(reach4LifeWorkbookSampleStory)
    const parsed = await parseIdml(buffer)
    const { strings } = await extractReach4LifeStrings(buffer, async () => parsed, {
      splitSentences: false,
    })

    expect(strings.map((cell) => cell.original)).toContain(SAMPLE_REACH4LIFE.lessonBlock)
    expect(strings.some((cell) => (
      cell.original === SAMPLE_REACH4LIFE.lessonBlockSentences[0]
    ))).toBe(false)
    expect(strings.every((cell) => cell.metadata?.idmlRejoin === undefined)).toBe(true)
  })

  it("keeps every cell's identity and protected anchors identical to its selected unit", async () => {
    const { parsed, result: { strings } } = await extractFrom()
    const { notes } = selectReach4LifeNotes(parsed.units)

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
      const paragraphUnit = parsed.units.find((candidate) => (
        candidate.locator.elementPath === unit.locator.elementPath
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
    const buffer = await makeReach4LifeIdml()
    const parsed = await parseIdml(buffer)
    const parse = vi.fn(async () => parsed)
    const controller = new AbortController()
    const onProgress = vi.fn()

    await extractReach4LifeStrings(buffer, parse, { signal: controller.signal, onProgress })

    // Selection happens here, after the engine has parsed every literal location.
    expect(parse).toHaveBeenCalledWith(buffer, "generic", {
      signal: controller.signal,
      onProgress,
    })
  })

  it("returns no cells for a package that is scripture and furniture only", async () => {
    const { result: { strings, bookCodes } } = await extractFrom([
      scripture("p-v1", SAMPLE_REACH4LIFE.scriptureBody, { chapter: "1", verse: "1" }),
      styled("p-rh", "Page Elements:h", "Matthew"),
    ])

    expect(strings).toEqual([])
    expect(bookCodes).toEqual([])
  })
})
