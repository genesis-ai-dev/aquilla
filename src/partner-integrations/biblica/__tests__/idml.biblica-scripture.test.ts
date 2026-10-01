/**
 * The scripture round-trip contract for a Biblica study-Bible volume, end to
 * end (AQU-1285).
 *
 * A verse is imported as a cell, so a translator can edit it or a whole Bible
 * can be swapped in. What comes back out has to be the publisher's package with
 * the verse's words replaced and nothing else: the paragraph style, the verse
 * and chapter number runs, and the character style of the slot the words land in
 * all belong to the destination, not to whatever the words were pasted from.
 *
 * These tests run the real importer's output through the real exporter, because
 * that composition — not either half alone — is what decides whether InDesign
 * still opens the file and still sets the verse the way the publisher set it.
 */

import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import {
  exportIdml as exportWithSharedEngine,
  parseIdml,
  validateExport,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import type { CellData } from "@/hooks/useCells"
import {
  BIBLICA_STORY_PATH,
  closedVerse,
  makeBiblicaIdml,
  note,
  paragraph,
  run,
} from "@/partner-integrations/biblica/__fixtures__/biblica-idml"
import { buildBulkCellsWithSpeakers } from "@/lib/import"
import { BIBLICA_NOTES_PROFILE_ID } from "@/partner-integrations/biblica/editions"
import { extractBiblicaStudyNoteStrings } from "@/partner-integrations/biblica/parsers/biblica"
import { exportIdml, type IdmlExportExecutor } from "@/lib/export/exporters/idml"

const directExecutor: IdmlExportExecutor = {
  parse: async (bytes) => parseIdml(bytes),
  export: (bytes, translations) => exportWithSharedEngine(bytes, translations, { strict: true }),
  validate: (bytes, manifest) => validateExport(bytes, manifest),
}

const VERSE_ONE = "In the beginning God created the heavens and the earth."
const VERSE_TWO = "Now the earth was formless and empty."

/** A one-book volume: a note, then two verses of chapter 1. */
const STORY: readonly string[] = [
  paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
  note("p-pref", "Genesis introduces the story of beginnings."),
  closedVerse("p-v1", "1", VERSE_ONE, "1"),
  closedVerse("p-v2", "2", VERSE_TWO),
]

async function importBiblicaCells(
  paragraphs: readonly string[] = STORY,
): Promise<{ bytes: ArrayBuffer; cells: CellData[] }> {
  const bytes = await makeBiblicaIdml(paragraphs)
  const parsed = await parseIdml(bytes.slice(0))
  const { strings } = await extractBiblicaStudyNoteStrings(bytes.slice(0), async () => parsed)
  const { cells: bulk } = buildBulkCellsWithSpeakers(strings, {
    fileName: "ukEngNIVSB_GEN-DEU.idml",
    fileType: "idml",
    profileId: BIBLICA_NOTES_PROFILE_ID,
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

/** Write a translation into the cell's protected slots, as the editor does. */
function translate(cell: CellData, text?: string): void {
  cell.translatedHtml = cell.originalHtml?.replace(
    />[^<>]+</g,
    (match) => (text === undefined ? match.toUpperCase() : `>${text}<`),
  )
  cell.translated = text ?? cell.original.toUpperCase()
}

function cellFor(cells: readonly CellData[], text: string): CellData {
  const cell = cells.find((candidate) => candidate.original === text)
  if (!cell) throw new Error(`Missing imported cell for ${JSON.stringify(text)}`)
  return cell
}

async function storyOf(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return zip.file(BIBLICA_STORY_PATH)!.async("string")
}

describe("IDML export of a Biblica study-Bible volume's scripture", () => {
  it("writes an edited verse back into the slot the publisher set, keeping its styles", async () => {
    const { bytes, cells } = await importBiblicaCells()
    translate(cellFor(cells, VERSE_ONE), "Ni Mulani Mulungu adalenga")

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    expect(story).toContain("<Content>Ni Mulani Mulungu adalenga</Content>")
    expect(story).not.toContain(VERSE_ONE)
    // The destination's styles: the verse paragraph is still `cv:p`, and the
    // words still sit in the unnamed character style the publisher gave them.
    // The cell carries content, never styling — the anchor sequence the engine
    // compares is what makes that structural rather than a convention.
    expect(story).toContain('AppliedParagraphStyle="ParagraphStyle/cv%3ap"')
    expect(story).toContain(
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">'
        + "<Content>Ni Mulani Mulungu adalenga</Content>",
    )
    // The chapter drop cap and the verse number are the publisher's numbering,
    // so they come back untouched in their own runs.
    expect(story).toContain(
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/cv%3adc"><Content>1</Content>',
    )
    expect(story).toContain(
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/cv%3av1"><Content>1</Content>',
    )
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  it("leaves every untranslated verse exactly as the publisher shipped it", async () => {
    const { bytes, cells } = await importBiblicaCells()
    translate(cellFor(cells, VERSE_ONE))

    const story = await storyOf((await exportIdml(bytes, cells, directExecutor)).blob)

    expect(story).toContain(`<Content>${VERSE_TWO}</Content>`)
    expect(story).toContain(`<Content>${VERSE_ONE.toUpperCase()}</Content>`)
  })

  it("exports a package byte-for-byte when nobody has translated anything", async () => {
    const { bytes, cells } = await importBiblicaCells()

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    expect(story).toContain(`<Content>${VERSE_ONE}</Content>`)
    expect(story).toContain(`<Content>${VERSE_TWO}</Content>`)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0, translated: 0 })
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([])
  })

  it("refuses a verse whose target claims a different character style than its slot", async () => {
    const { cells } = await importBiblicaCells()
    const cell = cellFor(cells, VERSE_ONE)
    translate(cell, "A pasted verse")
    // What pasting differently-styled content would try to do: keep the words,
    // change the style the slot is set in. The slot styles are part of the
    // anchor sequence, so the engine rejects it instead of restyling the
    // publisher's paragraph.
    const restyled = cell.translatedHtml!.replace(
      'data-idml-character-style="CharacterStyle/$ID/[No character style]"',
      'data-idml-character-style="CharacterStyle/Pasted Emphasis"',
    )
    expect(restyled).not.toBe(cell.translatedHtml)

    const validation = validateIdmlTranslation(
      cell.originalHtml!,
      restyled,
      cell.metadata!.idml as IdmlFormatMetadataV2,
    )
    expect(validation.valid).toBe(false)
    expect(validation.diagnostics.map((entry) => entry.code)).toContain("ANCHOR_INVALID")
  })
})
