/**
 * The Treasure Hunt cut-on-import / rejoin-on-export contract, end to end.
 *
 * A Treasure Hunt fact block is imported as one cell per sentence, which is
 * finer than IDML can address, and the volume's Bible text is never imported at
 * all. These tests run the real importer's output through the real exporter,
 * because that composition — not either half alone — is what decides whether a
 * publisher's file comes back intact.
 */

import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import {
  exportIdml as exportWithSharedEngine,
  parseIdml,
  validateExport,
} from "@aquilla/idml-roundtrip"
import type { CellData } from "@/hooks/useCells"
import {
  SAMPLE_TREASURE_HUNT,
  TREASURE_HUNT_STORY_PATH,
  makeTreasureHuntIdml,
} from "@/lib/partner-integrations/biblica/treasure-hunt/__fixtures__/treasure-hunt-idml"
import { buildBulkCellsWithSpeakers, TREASURE_HUNT_PROFILE_ID } from "@/lib/import"
import { extractTreasureHuntStrings } from "@/lib/partner-integrations/biblica/parsers/biblica-treasure-hunt"
import { exportIdml, IdmlWebExportError, type IdmlExportExecutor } from "./idml"

const directExecutor: IdmlExportExecutor = {
  parse: async (bytes) => parseIdml(bytes),
  export: (bytes, translations) => exportWithSharedEngine(bytes, translations, { strict: true }),
  validate: (bytes, manifest) => validateExport(bytes, manifest),
}

/** Import the fixture exactly as the app does, then hand back editable cells. */
async function importTreasureHuntCells(): Promise<{ bytes: ArrayBuffer; cells: CellData[] }> {
  const bytes = await makeTreasureHuntIdml()
  const parsed = await parseIdml(bytes.slice(0))
  const { strings } = await extractTreasureHuntStrings(bytes.slice(0), async () => parsed)
  const { cells: bulk } = buildBulkCellsWithSpeakers(strings, {
    fileName: "ukNIRV13_THB-01-05-Gen-Deu.idml",
    fileType: "idml",
    profileId: TREASURE_HUNT_PROFILE_ID,
    profileVersion: "1",
  })

  return {
    bytes,
    cells: bulk.map((cell, index): CellData => {
      const source = strings[index]!
      return {
        id: cell.cellId,
        fileId: "file-treasure-hunt",
        original: cell.value,
        originalHtml: source.originalHtml,
        translated: "",
        translatedHtml: source.translatedHtml,
        context: "IDML",
        group: "treasure-hunt",
        type: "text",
        status: "empty",
        validationStatus: "empty",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
        metadata: cell.metadata,
      }
    }),
  }
}

/** Translate a cell by upper-casing the text inside its protected slots. */
function translate(cell: CellData): void {
  cell.translatedHtml = cell.originalHtml?.replace(/>[^<>]+</g, (match) => match.toUpperCase())
  cell.translated = cell.original.toUpperCase()
}

function cellsFor(cells: readonly CellData[], texts: readonly string[]): CellData[] {
  return texts.map((text) => {
    const cell = cells.find((candidate) => candidate.original === text)
    if (!cell) throw new Error(`Missing imported cell for ${JSON.stringify(text)}`)
    return cell
  })
}

async function storyOf(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return zip.file(TREASURE_HUNT_STORY_PATH)!.async("string")
}

describe("IDML export of a Treasure Hunt volume", () => {
  it("merges every sentence of a fact block back into the one paragraph it came from", async () => {
    const { bytes, cells } = await importTreasureHuntCells()
    for (const cell of cellsFor(cells, SAMPLE_TREASURE_HUNT.factBlockSentences)) translate(cell)

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    // One paragraph, one Content run: the split leaves no trace in the package.
    expect(story).toContain(`<Content>${SAMPLE_TREASURE_HUNT.factBlock.toUpperCase()}</Content>`)
    expect(story).not.toContain(SAMPLE_TREASURE_HUNT.factBlock)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  it("keeps the publisher's sentences that nobody has translated yet", async () => {
    const { bytes, cells } = await importTreasureHuntCells()
    const [first, , third] = cellsFor(cells, SAMPLE_TREASURE_HUNT.factBlockSentences)
    translate(first!)
    translate(third!)

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(
      `<Content>${SAMPLE_TREASURE_HUNT.factBlockSentences[0].toUpperCase()}`
        + `${SAMPLE_TREASURE_HUNT.factBlockSentences[1]}`
        + `${SAMPLE_TREASURE_HUNT.factBlockSentences[2].toUpperCase()}</Content>`,
    )
  })

  it("writes back the apparatus, the introductions and the front matter alike", async () => {
    const { bytes, cells } = await importTreasureHuntCells()
    for (const cell of cellsFor(cells, [
      SAMPLE_TREASURE_HUNT.frontMatterTitle,
      SAMPLE_TREASURE_HUNT.introHead,
      SAMPLE_TREASURE_HUNT.huntNote,
      ...SAMPLE_TREASURE_HUNT.introList,
      ...SAMPLE_TREASURE_HUNT.huntSteps,
      ...SAMPLE_TREASURE_HUNT.factBlockSentences,
    ])) {
      translate(cell)
    }

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(`<Content>${SAMPLE_TREASURE_HUNT.frontMatterTitle.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_TREASURE_HUNT.introHead.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_TREASURE_HUNT.huntNote.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_TREASURE_HUNT.factBlock.toUpperCase()}</Content>`)
    // Line-broken lists keep their breaks: those parts are real locators the
    // engine merges itself, and they are unaffected by sentence rejoining.
    expect(story).toContain(
      SAMPLE_TREASURE_HUNT.huntSteps.map((line) => `<Content>${line.toUpperCase()}</Content>`)
        .join("<Br/>"),
    )
  })

  it("leaves the published Bible text exactly as the publisher set it", async () => {
    const { bytes, cells } = await importTreasureHuntCells()
    for (const cell of cells) translate(cell)

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    // Scripture was never imported, so it cannot have been rewritten.
    expect(story).toContain(`<Content>${SAMPLE_TREASURE_HUNT.scriptureBody}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_TREASURE_HUNT.scriptureHead}</Content>`)
    expect(story).toContain(`AppliedParagraphStyle="ParagraphStyle/pSectionHead"`)
  })

  it("leaves the package byte-identical when nothing has been translated", async () => {
    const { bytes, cells } = await importTreasureHuntCells()

    const result = await exportIdml(bytes.slice(0), cells, directExecutor)

    expect(result.report.translated).toBe(0)
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array(bytes))
  })

  it("refuses to export a fact block whose other sentences are absent", async () => {
    const { bytes, cells } = await importTreasureHuntCells()
    const sentences = cellsFor(cells, SAMPLE_TREASURE_HUNT.factBlockSentences)
    translate(sentences[0]!)
    const partial = cells.filter((cell) => cell !== sentences[1])

    await expect(exportIdml(bytes, partial, directExecutor)).rejects.toThrow(
      /1 of them are missing from this export/,
    )
  })

  it("refuses to export a sentence whose ranges no longer fit its paragraph", async () => {
    const { bytes, cells } = await importTreasureHuntCells()
    const sentences = cellsFor(cells, SAMPLE_TREASURE_HUNT.factBlockSentences)
    translate(sentences[0]!)
    sentences[0]!.metadata = {
      ...sentences[0]!.metadata,
      idmlRejoin: { version: 1, index: 0, count: 3, ranges: [{ slot: 0, start: 0, end: 9_000 }] },
    }

    await expect(exportIdml(bytes, cells, directExecutor))
      .rejects.toBeInstanceOf(IdmlWebExportError)
  })
})
