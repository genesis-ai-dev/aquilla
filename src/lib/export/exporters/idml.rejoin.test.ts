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
  FRONT_BACK_MATTER,
  SAMPLE_NOTES,
  biblicaFrontBackMatterStory,
  makeBiblicaIdml,
  note,
  noteWithTrailingVerseMarker,
  paragraph,
  run,
  verseMarkerOnlyNote,
} from "@/lib/biblica/__fixtures__/biblica-idml"
import { buildBulkCellsWithSpeakers } from "@/lib/import"
import { normalizeProtectedCompletion } from "@/lib/idml/completion"
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
 * this rejoin contract exists for. Pass `paragraphs` to import a custom story
 * (verse-marker flush fixtures) instead of the sample notes package.
 */
async function importBiblicaCells(
  paragraphs?: readonly string[],
): Promise<{ bytes: ArrayBuffer; cells: CellData[] }> {
  const bytes = await makeBiblicaIdml(paragraphs)
  const parsed = await parseIdml(bytes.slice(0))
  const { strings } = await extractBiblicaStudyNoteStrings(
    bytes.slice(0),
    async () => parsed,
    { splitSentences: true },
  )
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

  /**
   * AQU-1234 is why the Agent API refuses InsertCell / DeleteCell / SplitCell on
   * a file imported with preserved export slots: a row that never came from the
   * package has no locator, and the exporter has nowhere to put it. That refusal
   * lives at the editing gate (`rowActionAvailability`), NOT here.
   *
   * AQU-1068 settled what the exporter does if such a row reaches it anyway: an
   * added row is marked with `aquillaOrigin`, and the exporter leaves it out
   * rather than failing the download, because losing the whole deliverable over
   * one stray line is the worse failure. AQU-1343: these two tests pin both
   * halves, which previously disagreed — the marked row is skipped, an unmarked
   * row with no locator still stops the export.
   */
  it("leaves a row somebody added after the import out of the export", async () => {
    const { bytes, cells } = await importBiblicaCells()
    for (const cell of cells) translate(cell)
    const inserted: CellData = {
      ...cells[0]!,
      id: "inserted-line",
      original: "A line somebody added after the import.",
      originalHtml: undefined,
      translatedHtml: undefined,
      metadata: { aquillaOrigin: { version: 1, kind: "user-insert" } },
    }

    const baseline = await exportIdml(bytes.slice(0), cells, directExecutor)
    const result = await exportIdml(bytes, [...cells, inserted], directExecutor)
    const story = await storyOf(result.blob)

    // The added line is dropped, and every imported row still lands: the export
    // is byte-identical to the one without it.
    expect(story).not.toContain("A line somebody added after the import.")
    expect(result.report).toMatchObject({
      missing: 0,
      rejected: 0,
      translated: baseline.report.translated,
    })
    expect(new Uint8Array(await result.blob.arrayBuffer()))
      .toEqual(new Uint8Array(await baseline.blob.arrayBuffer()))
  })

  it("refuses to export a row that carries no IDML locator and no added-line marker", async () => {
    const { bytes, cells } = await importBiblicaCells()
    for (const cell of cells) translate(cell)
    // Same row as above minus `aquillaOrigin`: nothing says a person added it,
    // so it reads as an imported row whose locator went missing — corruption the
    // exporter must not paper over by silently dropping the content.
    const orphaned: CellData = {
      ...cells[0]!,
      id: "orphaned-line",
      original: "A row whose IDML locator went missing.",
      originalHtml: undefined,
      translatedHtml: undefined,
      metadata: {},
    }

    await expect(exportIdml(bytes, [...cells, orphaned], directExecutor)).rejects.toThrow(
      IdmlWebExportError,
    )
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

  it("writes a translated note back around the verse marker it was cut from", async () => {
    const noteText = "Jesus sends his followers out."
    const { bytes, cells } = await importBiblicaCells([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "MRK")),
      note("p-title", "The Gospel of Mark", "intro%3aimt1"),
      noteWithTrailingVerseMarker("p-n", noteText, "20"),
      verseMarkerOnlyNote("p-ie", "28", "20"),
    ])

    // The markers own no cell, so only the two notes were imported.
    expect(cells.map((cell) => cell.original)).toEqual(["The Gospel of Mark", noteText])
    for (const cell of cells) translate(cell)

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    expect(story).toContain(`<Content>${noteText.toUpperCase()}</Content>`)
    // Both delimiter runs come back exactly as the publisher set them: IDML
    // needs them to close Matthew's last verse.
    expect(story).toContain(`<Content>28:</Content>`)
    expect(story.match(/<Content>20<\/Content>/g)).toHaveLength(2)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  // AQU-1174: the "source serif" apostrophe run is English typesetting glue.
  // A model asked to translate its slot copies the apostrophe through, gluing a
  // stray `'` onto translated words in the editor and in the exported story.
  it("does not write the publisher's apostrophe glue onto translated words", async () => {
    const { bytes, cells } = await importBiblicaCells([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      paragraph(
        "p-n",
        "intro%3aip",
        run("$ID/[No character style]", "Israel")
          + run("source%20serif", "ʼ")
          + run("$ID/[No character style]", "s covenant history begins here."),
      ),
    ])
    const cell = cells[0]!
    expect(cell.original).toBe("Israelʼs covenant history begins here.")

    // The draft the model returns: prose translated, glue slot copied verbatim.
    const drafted = normalizeProtectedCompletion(
      { id: cell.id, originalHtml: cell.originalHtml, metadata: cell.metadata },
      cell.originalHtml!.replace(/>([^<>]+)</g, (match, text: string) =>
        text === "ʼ" ? match : match.toUpperCase()),
    )
    cell.translated = drafted.value
    cell.translatedHtml = drafted.valueHtml

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    expect(story).toContain("<Content>ISRAEL</Content>")
    expect(story).toContain("<Content>S COVENANT HISTORY BEGINS HERE.</Content>")
    // The glue run keeps its element — IDML needs the anchor — but carries no
    // apostrophe into the Marathi text.
    expect(story).not.toContain("<Content>ʼ</Content>")
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
  })

  it("writes a translated front/back matter volume back into its layout paragraphs", async () => {
    const { bytes, cells } = await importBiblicaCells(biblicaFrontBackMatterStory)

    expect(cells.map((cell) => cell.original)).toEqual([
      FRONT_BACK_MATTER.title,
      FRONT_BACK_MATTER.firstLetter,
      FRONT_BACK_MATTER.firstEntry,
      FRONT_BACK_MATTER.firstBody.join(""),
      FRONT_BACK_MATTER.secondLetter,
      FRONT_BACK_MATTER.secondEntry,
    ])
    for (const cell of cells) translate(cell)

    const result = await exportIdml(bytes, cells, directExecutor)
    const story = await storyOf(result.blob)

    expect(story).toContain(`<Content>${FRONT_BACK_MATTER.title.toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${FRONT_BACK_MATTER.firstEntry.toUpperCase()}</Content>`)
    // The apostrophe is an ordinary possessive here, so its run is written back
    // with the words around it rather than held at the publisher's text.
    expect(story).toContain(`<Content>${FRONT_BACK_MATTER.firstBody[0].toUpperCase()}</Content>`)
    expect(story).toContain(`<Content>${FRONT_BACK_MATTER.firstBody[2].toUpperCase()}</Content>`)
    // The running head owns no cell, so InDesign's own text survives untouched.
    expect(story).toContain(`<Content>${FRONT_BACK_MATTER.runningHead}</Content>`)
    expect(result.report).toMatchObject({ missing: 0, rejected: 0 })
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
