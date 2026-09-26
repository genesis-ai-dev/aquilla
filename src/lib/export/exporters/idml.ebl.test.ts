/**
 * The EBL contents-page-number contract, end to end.
 *
 * A contents title is imported without its page number so a translator never
 * types a digit that will still be a digit after translation. These tests run
 * the real importer's output through the real exporter, because that composition
 * is what decides whether the publisher's number is still in the file afterwards.
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
  EBL_BODY_STORY_PATH,
  SAMPLE_EBL,
  makeEblIdml,
  styled,
  tocEntriesWithPageRuns,
} from "@/lib/biblica/ebl/__fixtures__/ebl-idml"
import { buildBulkCellsWithSpeakers, EBL_PROFILE_ID } from "@/lib/import"
import { extractEblStrings } from "@/lib/parsers/biblica-ebl"
import { exportIdml, type IdmlExportExecutor } from "./idml"

const directExecutor: IdmlExportExecutor = {
  parse: async (bytes) => parseIdml(bytes),
  export: (bytes, translations) => exportWithSharedEngine(bytes, translations, { strict: true }),
  validate: (bytes, manifest) => validateExport(bytes, manifest),
}

const TOC_ENTRIES = SAMPLE_EBL.contentsTitles.map((title, index) => ({
  title,
  page: SAMPLE_EBL.contentsPages[index]!,
}))

async function importEblCells(): Promise<{ bytes: ArrayBuffer; cells: CellData[] }> {
  const bytes = await makeEblIdml({
    body: [
      styled("h", "02_TOC:ms1", SAMPLE_EBL.contentsHead),
      tocEntriesWithPageRuns("toc", "02_TOC:tc1", TOC_ENTRIES),
      styled("nested", "02_TOC:tc3", SAMPLE_EBL.contentsNestedEntry),
    ],
    badge: [],
    summary: [],
  })
  const parsed = await parseIdml(bytes.slice(0))
  const { strings } = await extractEblStrings(bytes.slice(0), async () => parsed)
  const { cells: bulk } = buildBulkCellsWithSpeakers(strings, {
    fileName: "ukEng_MODULE 1_EBL_FACILITATOR GUIDE.idml",
    fileType: "idml",
    profileId: EBL_PROFILE_ID,
    profileVersion: "1",
  })

  return {
    bytes,
    cells: bulk.map((cell, index): CellData => {
      const source = strings[index]!
      return {
        id: cell.cellId,
        fileId: "file-ebl",
        original: cell.value,
        originalHtml: source.originalHtml,
        translated: "",
        translatedHtml: source.translatedHtml,
        context: "IDML",
        group: "ebl",
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

function translate(cell: CellData): void {
  cell.translatedHtml = cell.originalHtml?.replace(/>[^<>]+</g, (match) => match.toUpperCase())
  cell.translated = cell.original.toUpperCase()
}

function cellFor(cells: readonly CellData[], text: string): CellData {
  const cell = cells.find((candidate) => candidate.original === text)
  if (!cell) throw new Error(`Missing imported cell for ${JSON.stringify(text)}`)
  return cell
}

async function storyOf(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return zip.file(EBL_BODY_STORY_PATH)!.async("string")
}

describe("IDML export of an EBL contents page", () => {
  it("writes a translated title back without moving the neighbouring page-number run", async () => {
    const { bytes, cells } = await importEblCells()
    translate(cellFor(cells, SAMPLE_EBL.contentsTitles[0]!))

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    expect(story).toContain(`<Content>${SAMPLE_EBL.contentsTitles[0]!.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${SAMPLE_EBL.contentsPages[0]}</Content>`)
    expect(story).not.toContain(`<Content>${SAMPLE_EBL.contentsTitles[0]}</Content>`)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  it("keeps a same-run page number when only the title in front of it is translated", async () => {
    const { bytes, cells } = await importEblCells()
    translate(cellFor(cells, SAMPLE_EBL.contentsNestedTitle))

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(
      `<Content>${SAMPLE_EBL.contentsNestedTitle.toUpperCase()}`
        + `\t\t\t${SAMPLE_EBL.contentsNestedPage}</Content>`,
    )
  })
})
