import { describe, expect, it } from "vitest"
import { parseIdml } from "@aquilla/idml-roundtrip"
import {
  BIBLICA_FRONT_MATTER_OPENING_SECTION,
  isBiblicaFrontMatterVolume,
  selectBiblicaFrontMatter,
} from "./front-matter"
import {
  SAMPLE_FRONT_MATTER,
  SAMPLE_FRONT_MATTER_AARON,
  biblicaFrontMatterStory,
  biblicaSampleStory,
  layoutParagraph,
  makeBiblicaIdml,
} from "./__fixtures__/biblica-idml"

async function frontMatterUnits(paragraphs = biblicaFrontMatterStory) {
  return (await parseIdml(await makeBiblicaIdml(paragraphs))).units
}

describe("Biblica volume detection", () => {
  it("reads a package that marks no chapter or verse as front/back matter", async () => {
    expect(isBiblicaFrontMatterVolume(await frontMatterUnits())).toBe(true)
  })

  it("leaves a study-notes volume — which marks the verses its notes annotate — alone", async () => {
    expect(isBiblicaFrontMatterVolume(await frontMatterUnits(biblicaSampleStory))).toBe(false)
  })
})

describe("Biblica front/back-matter selection", () => {
  it("imports every text-bearing paragraph, sectioned by the volume's own headings", async () => {
    const selection = selectBiblicaFrontMatter(await frontMatterUnits())

    expect(selection.cells.map((cell) => [cell.unit.sourceText, cell.sectionLabel])).toEqual([
      // Text ahead of the first heading opens the file.
      [SAMPLE_FRONT_MATTER.title, BIBLICA_FRONT_MATTER_OPENING_SECTION],
      // The contents list is one IDML paragraph; each line is its own cell.
      [SAMPLE_FRONT_MATTER.contents[0], BIBLICA_FRONT_MATTER_OPENING_SECTION],
      [SAMPLE_FRONT_MATTER.contents[1], BIBLICA_FRONT_MATTER_OPENING_SECTION],
      [SAMPLE_FRONT_MATTER.contents[2], BIBLICA_FRONT_MATTER_OPENING_SECTION],
      // A `head:ms1` letter opens its section and stays editable inside it.
      [SAMPLE_FRONT_MATTER.letterA, SAMPLE_FRONT_MATTER.letterA],
      [SAMPLE_FRONT_MATTER_AARON, SAMPLE_FRONT_MATTER.letterA],
      [SAMPLE_FRONT_MATTER.letterB, SAMPLE_FRONT_MATTER.letterB],
      [SAMPLE_FRONT_MATTER.babel, SAMPLE_FRONT_MATTER.letterB],
      // `intro:imt2` opens a section the same way.
      [SAMPLE_FRONT_MATTER.usageHeading, SAMPLE_FRONT_MATTER.usageHeading],
      [SAMPLE_FRONT_MATTER.usageBody, SAMPLE_FRONT_MATTER.usageHeading],
    ])
  })

  it("gives auto-generated running heads no cell", async () => {
    const selection = selectBiblicaFrontMatter(await frontMatterUnits())

    expect(selection.cells.some((cell) => (
      cell.unit.sourceText.includes(SAMPLE_FRONT_MATTER.runningHead)
    ))).toBe(false)
    expect(selection.otherUnitCount).toBe(1)
  })

  it("keeps a source-serif apostrophe inside the word it belongs to", async () => {
    const selection = selectBiblicaFrontMatter(await frontMatterUnits())
    const aaron = selection.cells.find((cell) => cell.unit.sourceText.startsWith("Aaron:"))

    // The same run is structural glue in a study note, where it owns no cell;
    // in prose it is a possessive and has to reach the translator.
    expect(aaron?.unit.sourceText).toBe(SAMPLE_FRONT_MATTER_AARON)
    expect(aaron?.unit.sourceText).toContain("ʼ")
  })

  it("owns no cell for a paragraph whose only content is structural", async () => {
    const selection = selectBiblicaFrontMatter(await frontMatterUnits([
      layoutParagraph("f-title", SAMPLE_FRONT_MATTER.title, "title%3amt1"),
      layoutParagraph("f-ace", "<?ACE 7?>", "meta%3aft"),
    ]))

    // The engine drops a paragraph whose visible content is only an ACE marker
    // before an adapter sees it, so the selection never has to reject it.
    expect(selection.cells.map((cell) => cell.unit.sourceText)).toEqual([
      SAMPLE_FRONT_MATTER.title,
    ])
  })

  it("cuts a long paragraph into sentence cells that carry their rejoin ranges", async () => {
    const first = "The dictionary explains the people and places of the Bible in plain words. "
    const second = "Each entry names the book and chapter where the word is first used."
    const selection = selectBiblicaFrontMatter(
      await frontMatterUnits([layoutParagraph("f-long", `${first}${second}`)]),
      { splitSentences: true },
    )

    expect(selection.cells.map((cell) => cell.unit.sourceText)).toEqual([first, second])
    expect(selection.cells.map((cell) => cell.rejoin?.index)).toEqual([0, 1])
    expect(selection.cells.every((cell) => (cell.rejoin?.ranges.length ?? 0) > 0)).toBe(true)
  })
})
