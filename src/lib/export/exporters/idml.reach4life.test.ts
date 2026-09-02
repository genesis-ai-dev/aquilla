/**
 * The Reach 4 Life cut-on-import / rejoin-on-export contract, end to end.
 *
 * A Reach 4 Life lesson block is imported as one cell per sentence, which is
 * finer than IDML can address; the volume's continuous Bible text is never
 * imported, while a lesson's inline pull-quote is. These tests run the real
 * importer's output through the real exporter, because that composition — not
 * either half alone — is what decides whether a publisher's file comes back
 * intact.
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
  REACH4LIFE_STORY_PATH,
  SAMPLE_REACH4LIFE,
  makeReach4LifeIdml,
  reach4LifeWorkbookSampleStory,
} from "@/lib/partner-integrations/biblica/reach4life/__fixtures__/reach4life-idml"
import { buildBulkCellsWithSpeakers, REACH4LIFE_PROFILE_ID } from "@/lib/import"
import { extractReach4LifeStrings } from "@/lib/partner-integrations/biblica/parsers/biblica-reach4life"
import { exportIdml, IdmlWebExportError, type IdmlExportExecutor } from "./idml"

const directExecutor: IdmlExportExecutor = {
  parse: async (bytes) => parseIdml(bytes),
  export: (bytes, translations) => exportWithSharedEngine(bytes, translations, { strict: true }),
  validate: (bytes, manifest) => validateExport(bytes, manifest),
}

/** Import the fixture exactly as the app does, then hand back editable cells. */
async function importReach4LifeCells(
  paragraphs?: readonly string[],
): Promise<{ bytes: ArrayBuffer; cells: CellData[] }> {
  const bytes = await makeReach4LifeIdml(paragraphs)
  const parsed = await parseIdml(bytes.slice(0))
  const { strings } = await extractReach4LifeStrings(bytes.slice(0), async () => parsed)
  const { cells: bulk } = buildBulkCellsWithSpeakers(strings, {
    fileName: "ukEngR4Lv4_NT_FRT SECTION.idml",
    fileType: "idml",
    profileId: REACH4LIFE_PROFILE_ID,
    profileVersion: "1",
  })

  return {
    bytes,
    cells: bulk.map((cell, index): CellData => {
      const source = strings[index]!
      return {
        id: cell.cellId,
        fileId: "file-reach4life",
        original: cell.value,
        originalHtml: source.originalHtml,
        translated: "",
        translatedHtml: source.translatedHtml,
        context: "IDML",
        group: "reach4life",
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
  return zip.file(REACH4LIFE_STORY_PATH)!.async("string")
}

describe("IDML export of a Reach 4 Life workbook section", () => {
  it("merges every sentence of a lesson block back into the one paragraph it came from", async () => {
    const { bytes, cells } = await importReach4LifeCells(reach4LifeWorkbookSampleStory)
    for (const cell of cellsFor(cells, SAMPLE_REACH4LIFE.lessonBlockSentences)) translate(cell)

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    // One paragraph, one Content run: the split leaves no trace in the package.
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.lessonBlock.toUpperCase()}</Content>`)
    expect(story).not.toContain(SAMPLE_REACH4LIFE.lessonBlock)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  it("keeps the publisher's sentences that nobody has translated yet", async () => {
    const { bytes, cells } = await importReach4LifeCells(reach4LifeWorkbookSampleStory)
    const [first, , third] = cellsFor(cells, SAMPLE_REACH4LIFE.lessonBlockSentences)
    translate(first!)
    translate(third!)

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(
      `<Content>${SAMPLE_REACH4LIFE.lessonBlockSentences[0].toUpperCase()}`
        + `${SAMPLE_REACH4LIFE.lessonBlockSentences[1]}`
        + `${SAMPLE_REACH4LIFE.lessonBlockSentences[2].toUpperCase()}</Content>`,
    )
  })

  it("writes back a lesson's inline scripture quote with the lesson around it", async () => {
    const { bytes, cells } = await importReach4LifeCells(reach4LifeWorkbookSampleStory)
    for (const cell of cellsFor(cells, [
      SAMPLE_REACH4LIFE.lessonTitle,
      SAMPLE_REACH4LIFE.lessonQuote,
      SAMPLE_REACH4LIFE.lessonQuoteRef,
      SAMPLE_REACH4LIFE.storyBody,
      SAMPLE_REACH4LIFE.psalmHeading,
    ])) {
      translate(cell)
    }

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.lessonTitle.toUpperCase()}</Content>`)
    // The pull-quote is part of the lesson, so it travels with it.
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.lessonQuote.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.lessonQuoteRef.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.storyBody.toUpperCase()}</Content>`)
    // The Reach 4 Life heading above the Psalms reading is Reach 4 Life copy.
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.psalmHeading.toUpperCase()}</Content>`)
  })

  it("leaves the continuous Bible reading exactly as the publisher set it", async () => {
    const { bytes, cells } = await importReach4LifeCells(reach4LifeWorkbookSampleStory)
    for (const cell of cells) translate(cell)

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    // The Psalms text was never imported, so it cannot have been rewritten.
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.psalmLine}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.psalmSuperscription}</Content>`)
    // Nor was the page furniture or the typesetter's note to himself.
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.runningHead}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.productionNote}</Content>`)
  })

  it("writes back the book introductions while leaving the published text alone", async () => {
    const { bytes, cells } = await importReach4LifeCells()
    for (const cell of cells) translate(cell)

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.bookIntroHead.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.bookIntroBody.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.copyright.toUpperCase()}</Content>`)
    // A line-broken contents block keeps its breaks: those parts are real
    // locators the engine merges itself.
    expect(story).toContain(
      SAMPLE_REACH4LIFE.contentsEntries.map((line) => `<Content>${line.toUpperCase()}</Content>`)
        .join("<Br/>"),
    )

    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.scriptureBody}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.scriptureHead}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_REACH4LIFE.scriptureVerse}</Content>`)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  it("leaves the package byte-identical when nothing has been translated", async () => {
    const { bytes, cells } = await importReach4LifeCells(reach4LifeWorkbookSampleStory)

    const result = await exportIdml(bytes.slice(0), cells, directExecutor)

    expect(result.report.translated).toBe(0)
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array(bytes))
  })

  it("refuses to export a lesson block whose other sentences are absent", async () => {
    const { bytes, cells } = await importReach4LifeCells(reach4LifeWorkbookSampleStory)
    const sentences = cellsFor(cells, SAMPLE_REACH4LIFE.lessonBlockSentences)
    translate(sentences[0]!)
    const partial = cells.filter((cell) => cell !== sentences[1])

    await expect(exportIdml(bytes, partial, directExecutor)).rejects.toThrow(
      /1 of them are missing from this export/,
    )
  })

  it("refuses to export a sentence whose ranges no longer fit its paragraph", async () => {
    const { bytes, cells } = await importReach4LifeCells(reach4LifeWorkbookSampleStory)
    const sentences = cellsFor(cells, SAMPLE_REACH4LIFE.lessonBlockSentences)
    translate(sentences[0]!)
    sentences[0]!.metadata = {
      ...sentences[0]!.metadata,
      idmlRejoin: { version: 1, index: 0, count: 3, ranges: [{ slot: 0, start: 0, end: 9_000 }] },
    }

    await expect(exportIdml(bytes, cells, directExecutor))
      .rejects.toBeInstanceOf(IdmlWebExportError)
  })
})
