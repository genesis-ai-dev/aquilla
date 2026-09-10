import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
  type IdmlStyleCatalog,
} from "@aquilla/idml-roundtrip"
import {
  SAMPLE_TREASURE_HUNT,
  TREASURE_HUNT_STORY_PATH,
  makeTreasureHuntIdml,
  paragraph,
  run,
  scripture,
} from "@/lib/biblica/treasure-hunt/__fixtures__/treasure-hunt-idml"
import { selectTreasureHuntNotes } from "@/lib/biblica/treasure-hunt/notes"
import { prepareIdmlDisplayHtml } from "@/lib/richtext/idml-style-display"
import { extractTreasureHuntStrings } from "./biblica-treasure-hunt"

describe("Treasure Hunt parser adapter", () => {
  it("maps each selected note to one protected IDML cell with its book and chapter", async () => {
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const { strings, bookCodes, skipped } = await extractTreasureHuntStrings(
      buffer,
      async () => parsed,
    )

    expect(strings.map((cell) => [cell.original, cell.section])).toEqual([
      // Front matter precedes any book, so it carries no book code.
      [SAMPLE_TREASURE_HUNT.frontMatterTitle, "Intro"],
      [SAMPLE_TREASURE_HUNT.frontMatter, "Intro"],
      // The section heading is set above the book title it opens.
      [SAMPLE_TREASURE_HUNT.introSection, "GEN Intro"],
      [SAMPLE_TREASURE_HUNT.introBook, "GEN Intro"],
      [SAMPLE_TREASURE_HUNT.introHead, "GEN Intro"],
      [SAMPLE_TREASURE_HUNT.introList[0], "GEN Intro"],
      [SAMPLE_TREASURE_HUNT.introList[1], "GEN Intro"],
      [SAMPLE_TREASURE_HUNT.factHead, "GEN 1"],
      [SAMPLE_TREASURE_HUNT.factBlockSentences[0], "GEN 1"],
      [SAMPLE_TREASURE_HUNT.factBlockSentences[1], "GEN 1"],
      [SAMPLE_TREASURE_HUNT.factBlockSentences[2], "GEN 1"],
      [SAMPLE_TREASURE_HUNT.huntHead, "GEN 3"],
      [SAMPLE_TREASURE_HUNT.huntNote, "GEN 3"],
      [SAMPLE_TREASURE_HUNT.huntSteps[0], "GEN 3"],
      [SAMPLE_TREASURE_HUNT.huntSteps[1], "GEN 3"],
      [SAMPLE_TREASURE_HUNT.rangeHead, "GEN 1-3"],
      ["Read these chapters and draw what you find.", "GEN 1-3"],
    ])
    expect(bookCodes).toEqual(["GEN"])
    expect(skipped).toEqual({ scriptureUnitCount: 3, otherUnitCount: 2 })

    for (const cell of strings) {
      expect(cell.type).toBe("text")
      expect(cell.sourceLocator).toMatchObject({
        kind: "idml",
        memberPath: TREASURE_HUNT_STORY_PATH,
      })
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.biblica).toMatchObject({ version: 1, edition: "treasure-hunt" })
    }
  })

  it("tags each cell with the part of the edition it came from", async () => {
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractTreasureHuntStrings(buffer, async () => parsed)

    const contentTypeOf = (text: string) => {
      const cell = strings.find((candidate) => candidate.original === text)
      return (cell?.metadata?.biblica as { contentType?: string } | undefined)?.contentType
    }
    expect(contentTypeOf(SAMPLE_TREASURE_HUNT.frontMatter)).toBe("front-matter")
    expect(contentTypeOf(SAMPLE_TREASURE_HUNT.introHead)).toBe("intro")
    expect(contentTypeOf(SAMPLE_TREASURE_HUNT.huntNote)).toBe("hunt")

    // The paragraph style is retained so a note's role stays auditable after import.
    expect(strings[12]!.metadata?.biblica).toMatchObject({
      paragraphStyle: "ParagraphStyle/!meta_par_ns",
    })
  })

  it("stamps hunt and intro heading paragraph faces so unstyled runs display Bold", async () => {
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractTreasureHuntStrings(buffer, async () => parsed)
    const byText = (text: string) => strings.find((cell) => cell.original === text)

    const huntHead = byText(SAMPLE_TREASURE_HUNT.huntHead)
    expect(huntHead?.metadata).toMatchObject({
      idmlParagraphStyle: "ParagraphStyle/!meta_hunt_head",
      idmlStyleDisplay: {
        "ParagraphStyle/!meta_hunt_head": { bold: true, italic: false },
      },
      biblica: { paragraphStyle: "ParagraphStyle/!meta_hunt_head" },
    })

    const introHead = byText(SAMPLE_TREASURE_HUNT.introHead)
    expect(introHead?.metadata).toMatchObject({
      idmlParagraphStyle: "ParagraphStyle/_intro_head",
      idmlStyleDisplay: {
        "ParagraphStyle/_intro_head": { bold: true, italic: false },
      },
    })

    const factHead = byText(SAMPLE_TREASURE_HUNT.factHead)
    expect(factHead?.metadata).toMatchObject({
      idmlParagraphStyle: "ParagraphStyle/!meta_fact_head",
    })
    expect(factHead?.metadata?.idmlStyleDisplay).toBeUndefined()

    const painted = prepareIdmlDisplayHtml(
      huntHead!.originalHtml!,
      huntHead!.metadata?.idmlStyleDisplay as IdmlStyleCatalog | undefined,
      huntHead!.metadata?.idmlParagraphStyle as string | undefined,
    )
    const root = document.createElement("div")
    root.innerHTML = painted
    const slot = root.querySelector<HTMLElement>("span[data-idml-protected=\"slot\"]")
    expect(slot?.textContent).toBe(SAMPLE_TREASURE_HUNT.huntHead)
    expect(slot?.style.fontWeight).toBe("700")
    expect(slot?.getAttribute("data-idml-character-style")).toBe(
      "CharacterStyle/$ID/[No character style]",
    )
  })

  it("only tags cells with a book once one has been named", async () => {
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractTreasureHuntStrings(buffer, async () => parsed)

    expect(strings[0]!.globalReferences).toBeUndefined()
    expect(strings[3]!.globalReferences).toEqual(["GEN"])
    expect(strings.at(-1)!.globalReferences).toEqual(["GEN"])
  })

  it("carries the rejoin ranges only on cells that are part of a sliced block", async () => {
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractTreasureHuntStrings(buffer, async () => parsed)

    const sentences = strings.filter((cell) => (
      SAMPLE_TREASURE_HUNT.factBlockSentences.some((sentence) => cell.original === sentence)
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

  it("keeps the fact block whole when sentence splitting is turned off", async () => {
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractTreasureHuntStrings(buffer, async () => parsed, {
      splitSentences: false,
    })

    expect(strings.map((cell) => cell.original)).toContain(SAMPLE_TREASURE_HUNT.factBlock)
    expect(strings.some((cell) => (
      cell.original === SAMPLE_TREASURE_HUNT.factBlockSentences[0]
    ))).toBe(false)
    expect(strings.every((cell) => cell.metadata?.idmlRejoin === undefined)).toBe(true)
  })

  it("keeps every cell's identity and protected anchors identical to its selected unit", async () => {
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const { strings } = await extractTreasureHuntStrings(buffer, async () => parsed)
    const { notes } = selectTreasureHuntNotes(parsed.units)

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
    const buffer = await makeTreasureHuntIdml()
    const parsed = await parseIdml(buffer)
    const parse = vi.fn(async () => parsed)
    const controller = new AbortController()
    const onProgress = vi.fn()

    await extractTreasureHuntStrings(buffer, parse, { signal: controller.signal, onProgress })

    // Selection happens here, after the engine has parsed every literal location.
    expect(parse).toHaveBeenCalledWith(buffer, "generic", {
      signal: controller.signal,
      onProgress,
    })
  })

  it("returns no cells for a package that is scripture and furniture only", async () => {
    const buffer = await makeTreasureHuntIdml([
      scripture("v1", "In the beginning, God created the heavens and the earth.", {
        chapter: "1",
        verse: "1",
      }),
      paragraph("p-proof", "zz.proof stages", run("$ID/[No character style]", "THB NirvA Firsts")),
    ])
    const parsed = await parseIdml(buffer)
    const { strings, bookCodes } = await extractTreasureHuntStrings(buffer, async () => parsed)

    expect(strings).toEqual([])
    expect(bookCodes).toEqual([])
  })
})
