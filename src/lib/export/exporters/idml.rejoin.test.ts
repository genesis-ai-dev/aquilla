/**
 * The cut-on-import / rejoin-on-export contract, end to end.
 *
 * With sentence splitting on, a Biblica note block is imported as one cell per
 * sentence, which is finer than IDML can address. These tests run the real
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
  BIBLICA_STORY_PATH,
  SAMPLE_NOTES,
  makeBiblicaIdml,
} from "@/lib/biblica/__fixtures__/biblica-idml"
import { buildBulkCellsWithSpeakers } from "@/lib/import"
import { extractBiblicaStudyNoteStrings } from "@/lib/parsers/biblica"
import { exportIdml, IdmlWebExportError, type IdmlExportExecutor } from "./idml"

const directExecutor: IdmlExportExecutor = {
  parse: async (bytes) => parseIdml(bytes),
  export: (bytes, translations) => exportWithSharedEngine(bytes, translations, { strict: true }),
  validate: (bytes, manifest) => validateExport(bytes, manifest),
}

/**
 * Import the fixture exactly as the app does when the importer's sentence
 * splitting is switched on. Splitting is opt-in — the default imports whole
 * paragraphs — and it is the only path that produces the sub-paragraph cells
 * this rejoin contract exists for.
 */
async function importBiblicaCells(): Promise<{ bytes: ArrayBuffer; cells: CellData[] }> {
  const bytes = await makeBiblicaIdml()
  const parsed = await parseIdml(bytes.slice(0))
  const { strings } = await extractBiblicaStudyNoteStrings(bytes.slice(0), async () => parsed, {
    splitSentences: true,
  })
  const { cells: bulk } = buildBulkCellsWithSpeakers(strings, {
    fileName: "Genesis-notes.idml",
    fileType: "idml",
    profileId: "biblica:notes",
    profileVersion: "1",
  })

  return {
    bytes,
    cells: bulk.map((cell, index): CellData => {
      const source = strings[index]!
      return {
        id: cell.cellId,
        fileId: "file-biblica",
        original: cell.value,
        originalHtml: source.originalHtml,
        translated: "",
        translatedHtml: source.translatedHtml,
        context: "IDML",
        group: "biblica",
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
  return zip.file(BIBLICA_STORY_PATH)!.async("string")
}

describe("IDML export of a note block that was imported as several cells", () => {
  it("merges every sentence back into the one paragraph it came from", async () => {
    const { bytes, cells } = await importBiblicaCells()
    const sentences = cellsFor(cells, SAMPLE_NOTES.noteBlockSentences)
    for (const cell of sentences) translate(cell)

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    // One paragraph, one Content run: the split leaves no trace in the package.
    expect(story).toContain(`<Content>${SAMPLE_NOTES.noteBlock.toUpperCase()}</Content>`)
    expect(story).not.toContain(SAMPLE_NOTES.noteBlock)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  it("keeps the publisher's sentences that nobody has translated yet", async () => {
    const { bytes, cells } = await importBiblicaCells()
    const [first, , third] = cellsFor(cells, SAMPLE_NOTES.noteBlockSentences)
    translate(first!)
    translate(third!)

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(
      `<Content>${SAMPLE_NOTES.noteBlockSentences[0].toUpperCase()}`
        + `${SAMPLE_NOTES.noteBlockSentences[1]}`
        + `${SAMPLE_NOTES.noteBlockSentences[2].toUpperCase()}</Content>`,
    )
  })

  it("leaves the block untouched when no sentence of it has been translated", async () => {
    const { bytes, cells } = await importBiblicaCells()

    const result = await exportIdml(bytes.slice(0), cells, directExecutor)

    expect(result.report.translated).toBe(0)
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array(bytes))
  })

  it("still exports whole-unit cells and line parts alongside the merged block", async () => {
    const { bytes, cells } = await importBiblicaCells()
    for (const cell of cellsFor(cells, [
      SAMPLE_NOTES.preface,
      ...SAMPLE_NOTES.referenceList,
      ...SAMPLE_NOTES.noteBlockSentences,
    ])) {
      translate(cell)
    }

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(`<Content>${SAMPLE_NOTES.preface.toUpperCase()}</Content>`)
    // The line-broken list keeps its breaks: those parts are real locators the
    // engine merges itself, and they are unaffected by sentence rejoining.
    expect(story).toContain(
      SAMPLE_NOTES.referenceList.map((line) => `<Content>${line.toUpperCase()}</Content>`)
        .join("<Br/>"),
    )
    expect(story).toContain(`<Content>${SAMPLE_NOTES.noteBlock.toUpperCase()}</Content>`)
    // Scripture was never imported, so it cannot have been rewritten.
    expect(story).toContain("<Content>In the beginning God created the heavens and the earth.</Content>")
  })

  it("refuses to export a note block whose other sentences are absent", async () => {
    const { bytes, cells } = await importBiblicaCells()
    const sentences = cellsFor(cells, SAMPLE_NOTES.noteBlockSentences)
    translate(sentences[0]!)
    const partial = cells.filter((cell) => cell !== sentences[1])

    await expect(exportIdml(bytes, partial, directExecutor)).rejects.toThrow(
      /1 of them are missing from this export/,
    )
  })

  it("refuses to export a sentence whose ranges no longer fit its paragraph", async () => {
    const { bytes, cells } = await importBiblicaCells()
    const sentences = cellsFor(cells, SAMPLE_NOTES.noteBlockSentences)
    translate(sentences[0]!)
    sentences[0]!.metadata = {
      ...sentences[0]!.metadata,
      idmlRejoin: {
        version: 1,
        index: 0,
        count: 3,
        ranges: [{ slot: 0, start: 0, end: 9_000 }],
      },
    }

    await expect(exportIdml(bytes, cells, directExecutor))
      .rejects.toBeInstanceOf(IdmlWebExportError)
  })
})
