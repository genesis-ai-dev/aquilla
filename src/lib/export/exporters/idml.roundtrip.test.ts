import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import {
  exportIdml as exportWithSharedEngine,
  parseIdml,
  renderIdmlUnitHtml,
  validateExport,
  validateIdmlTranslation,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import type { CellData } from "@/hooks/useCells"
import {
  exportIdml,
  IdmlWebExportError,
  type IdmlExportExecutor,
} from "./idml"

const STORY = "Stories/Story_u100.xml"
const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

const directExecutor: IdmlExportExecutor = {
  parse: async (bytes) => parseIdml(bytes),
  export: (bytes, translations) => exportWithSharedEngine(bytes, translations, { strict: true }),
  validate: (bytes, manifest) => validateExport(bytes, manifest),
}

describe("strict web IDML export adapter", () => {
  it("preserves mixed styles and translates nested footnote slots through persisted contracts", async () => {
    const raw = await buildFixture()
    const parsed = await parseIdml(raw)
    const heading = unitById(parsed.units, "heading")
    const mixed = unitById(parsed.units, "mixed")
    const footnote = unitById(parsed.units, "footnote")
    const cells = parsed.units.map((unit) => cellFor(unit))

    replaceCell(cells, heading, ["Chapitre Un"])
    replaceCell(cells, mixed, ["le ", "SEIGNEUR"])
    replaceCell(cells, footnote, ["note traduite"])

    const originalZip = await JSZip.loadAsync(raw)
    const result = await exportIdml(raw.slice(0), cells, directExecutor)
    const outputZip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const outputStory = await outputZip.file(STORY)!.async("string")

    expect(result.report).toMatchObject({ translated: 3, missing: 0, rejected: 0 })
    expect(outputStory).toContain("<Content>Chapitre Un</Content>")
    expect(outputStory).toContain(
      'AppliedCharacterStyle="CharacterStyle/Plain"><Content>le </Content>',
    )
    expect(outputStory).toContain(
      'AppliedCharacterStyle="CharacterStyle/Bold"><Content>SEIGNEUR</Content>',
    )
    expect(outputStory).toContain("<Content>note traduite</Content>")
    expect(
      await outputZip.file("Resources/Styles.xml")!.async("uint8array"),
    ).toEqual(
      await originalZip.file("Resources/Styles.xml")!.async("uint8array"),
    )
  })

  it("exports a user line break inside its original character-style slot", async () => {
    const raw = await buildFixture()
    const parsed = await parseIdml(raw)
    const heading = unitById(parsed.units, "heading")
    const cells = parsed.units.map((unit) => cellFor(unit))
    replaceCell(cells, heading, ["ligne un\nligne deux"])

    const result = await exportIdml(raw, cells, directExecutor)
    const outputZip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    await expect(outputZip.file(STORY)!.async("string")).resolves.toContain(
      "<Content>ligne un</Content><Br/><Content>ligne deux</Content>",
    )
  })

  it("downloads a file whose over-long NoBreak run can wrap, after structural validation", async () => {
    const sentence =
      ". Davi era senhor e rei. Mas o senhor e rei aqui não era Davi."
    const raw = await buildFixture(
      `<ParagraphStyleRange Self="pnote" AppliedParagraphStyle="ParagraphStyle/intro%3aipi">` +
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/k_xt" NoBreak="true"><Content>Melchizedek</Content></CharacterStyleRange>` +
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain" NoBreak="true"><Content>.</Content></CharacterStyleRange>` +
        `</ParagraphStyleRange>` +
        `<ParagraphStyleRange Self="plock" AppliedParagraphStyle="ParagraphStyle/Body">` +
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain" NoBreak="true"><Content>os d</Content></CharacterStyleRange>` +
        `</ParagraphStyleRange>`,
    )
    const parsed = await parseIdml(raw)
    const note = unitById(parsed.units, "pnote")
    const cells = parsed.units.map((unit) => cellFor(unit))
    replaceCell(cells, note, ["Melquisedeque", sentence])

    const result = await exportIdml(raw.slice(0), cells, directExecutor)
    const outputZip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const outputStory = await outputZip.file(STORY)!.async("string")

    expect(result.diagnostics).toEqual([])
    expect(outputStory).toContain(`NoBreak="true"><Content>Melquisedeque</Content>`)
    expect(outputStory).toContain(`NoBreak="true"><Content>os d</Content>`)
    expect(outputStory).toContain(`<Content>${sentence}</Content>`)
    expect(outputStory).not.toContain(`NoBreak="true"><Content>${sentence}</Content>`)
  })

  it("returns the exact original bytes when every protected target is empty", async () => {
    const raw = await buildFixture()
    const parsed = await parseIdml(raw)
    const cells = parsed.units.map((unit) => cellFor(unit))

    const result = await exportIdml(raw.slice(0), cells, directExecutor)
    expect(result.report.translated).toBe(0)
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array(raw))
  })

  it("blocks missing, stale, or malformed protected contracts before download", async () => {
    const raw = await buildFixture()
    const parsed = await parseIdml(raw)
    const unit = unitById(parsed.units, "heading")
    const missingLocator = cellFor(unit)
    missingLocator.metadata = { idml: unit.metadata }
    // A translation whose protected HTML is gone, and one whose anchors moved:
    // words the package cannot place block the download. (An EMPTY target in
    // either state is an untranslated cell — see the next test.)
    const missingTarget = cellFor(unit)
    missingTarget.translated = "Chapitre un"
    missingTarget.translatedHtml = undefined
    const changedAnchor = cellFor(unit)
    changedAnchor.translated = "Chapitre un"
    changedAnchor.translatedHtml = targetHtml(unit, ["Chapitre un"]).replace(
      'data-idml-slot="0"',
      'data-idml-slot="9"',
    )
    const plainOnlyTranslation = cellFor(unit)
    plainOnlyTranslation.translated = "translation outside protected HTML"

    for (const cell of [
      missingLocator,
      missingTarget,
      changedAnchor,
      plainOnlyTranslation,
    ]) {
      await expect(
        exportIdml(raw.slice(0), [cell], directExecutor),
      ).rejects.toBeInstanceOf(IdmlWebExportError)
    }
  })

  // WHY: a file a source link brought in has no target rows until someone
  // types, and a file whose source the link replaced (or a re-import changed)
  // still carries the empty shell of the OLD source — a slot it marks editable
  // is locked now, so the shell fails the anchor proof ("IDML slot N
  // editability was changed"). Neither cell holds a translation, so neither may
  // stop the download: the paragraph keeps the publisher's text, as any
  // untouched cell does, while a translated cell beside them still exports.
  it("leaves an untranslated cell alone when its target is missing or is the shell of an older source", async () => {
    const raw = await buildFixture()
    const parsed = await parseIdml(raw)
    const cells = parsed.units.map((unit) => cellFor(unit))
    const heading = unitById(parsed.units, "heading")
    const mixed = unitById(parsed.units, "mixed")
    const noTargetRow = cells.find((cell) => cell.id === heading.id)!
    noTargetRow.translatedHtml = undefined
    const staleShell = cells.find((cell) => cell.id === mixed.id)!
    // The shell an earlier import wrote, back when the bold run was locked.
    staleShell.translatedHtml = emptyTargetHtml(mixed).replace(
      'data-idml-slot="1" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot">',
      'data-idml-slot="1" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot" contenteditable="false">LORD',
    )
    expect(validateIdmlTranslation(mixed.sourceHtml, staleShell.translatedHtml, mixed.metadata).valid).toBe(false)
    replaceCell(cells, unitById(parsed.units, "footnote"), ["note traduite"])

    const result = await exportIdml(raw.slice(0), cells, directExecutor)

    expect(result.report.translated).toBe(1)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const outputStory = await zip.file(STORY)!.async("string")
    expect(outputStory).toContain("<Content>note traduite</Content>")
    expect(outputStory).toContain("<Content>Chapter One</Content>")
    expect(outputStory).toContain("<Content>LORD</Content>")

    // Words typed into a stale shell are a translation the package cannot
    // place: that cell still blocks, with the repair offer.
    const typedIntoStaleShell = cellFor(mixed)
    typedIntoStaleShell.translatedHtml = staleShell.translatedHtml.replace(
      'data-idml-protected="slot">',
      'data-idml-protected="slot">le ',
    )
    await expect(
      exportIdml(raw.slice(0), [typedIntoStaleShell], directExecutor),
    ).rejects.toBeInstanceOf(IdmlWebExportError)
  })

  // WHY: a file whose source a link replaced keeps the lines only it had, and
  // their locators still name paragraphs of the package it was imported from.
  // The linked package has nowhere to put them, so the download leaves them
  // out and names them — one blocked line must not hold back 500 placed ones.
  // Most translations having no paragraph is the other way round: the package
  // is not the one the cells describe, and that still blocks.
  it("leaves out a translated line whose paragraph this package does not have, and blocks when most are like that", async () => {
    const raw = await buildFixture()
    const parsed = await parseIdml(raw)
    const cells = parsed.units.map((unit) => cellFor(unit))
    replaceCell(cells, unitById(parsed.units, "heading"), ["Chapitre un"])
    const kept = cellFor(unitById(parsed.units, "footnote"))
    kept.id = "Stories/Story_u999.xml#/idPkg:Story[1]/Story[1]/ParagraphStyleRange[7]:part-0"
    kept.cellLabel = "27:34"
    kept.translated = "27.34"
    kept.translatedHtml = targetHtml(unitById(parsed.units, "footnote"), ["27.34"])
    kept.metadata = {
      ...kept.metadata,
      aquillaImport: {
        sourceLocator: {
          ...unitById(parsed.units, "footnote").locator,
          memberPath: "Stories/Story_u999.xml",
          elementId: "old-footnote",
        },
      },
    }

    const result = await exportIdml(raw.slice(0), [...cells, kept], directExecutor)

    expect(result.report.translated).toBe(1)
    expect(result.omitted).toEqual([{ cellId: kept.id, cellLabel: "27:34", text: "27.34" }])
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(await zip.file(STORY)!.async("string")).toContain("<Content>Chapitre un</Content>")

    await expect(
      exportIdml(raw.slice(0), [kept], directExecutor),
    ).rejects.toThrow(/not part of this IDML package/)
  })
})

function unitById(
  units: readonly IdmlTranslationUnit[],
  elementId: string,
): IdmlTranslationUnit {
  const unit = units.find((candidate) => candidate.locator.elementId === elementId)
  if (!unit) throw new Error(`Missing IDML fixture unit ${elementId}`)
  return unit
}

function emptyTargetHtml(unit: IdmlTranslationUnit): string {
  return renderIdmlUnitHtml({
    ...unit,
    slots: unit.slots.map((slot) => ({
      ...slot,
      text: slot.editable ? "" : slot.text,
    })),
  })
}

function targetHtml(unit: IdmlTranslationUnit, values: readonly string[]): string {
  return renderIdmlUnitHtml({
    ...unit,
    slots: unit.slots.map((slot, index) => ({
      ...slot,
      text: slot.editable ? values[index] ?? "" : slot.text,
    })),
  })
}

function cellFor(unit: IdmlTranslationUnit): CellData {
  return {
    id: unit.id,
    fileId: "file-idml",
    original: unit.sourceText,
    originalHtml: unit.sourceHtml,
    translated: "",
    translatedHtml: emptyTargetHtml(unit),
    context: "IDML",
    group: `idml-${unit.order}`,
    type: "text",
    status: "empty",
    validationStatus: "empty",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    metadata: {
      idml: unit.metadata,
      aquillaImport: {
        sourceLocator: unit.locator,
      },
    },
  }
}

function replaceCell(
  cells: CellData[],
  unit: IdmlTranslationUnit,
  values: readonly string[],
): void {
  const cell = cells.find((candidate) => candidate.id === unit.id)
  if (!cell) throw new Error(`Missing cell for ${unit.id}`)
  cell.translated = values.join("")
  cell.translatedHtml = targetHtml(unit, values)
}

async function buildFixture(extraParagraphs = ""): Promise<ArrayBuffer> {
  const story = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<idPkg:Story ${IDPKG}><Story Self="u100">`,
    extraParagraphs,
    '<ParagraphStyleRange Self="heading" AppliedParagraphStyle="ParagraphStyle/Heading">',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Chapter One</Content></CharacterStyleRange>',
    "</ParagraphStyleRange>",
    '<ParagraphStyleRange Self="mixed" AppliedParagraphStyle="ParagraphStyle/Body">',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>the </Content></CharacterStyleRange>',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>LORD</Content></CharacterStyleRange>',
    "</ParagraphStyleRange>",
    '<ParagraphStyleRange Self="carrier" AppliedParagraphStyle="ParagraphStyle/Body">',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Body</Content>',
    '<Footnote><ParagraphStyleRange Self="footnote" AppliedParagraphStyle="ParagraphStyle/Footnote">',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Footnote"><Content>source note</Content></CharacterStyleRange>',
    "</ParagraphStyleRange></Footnote></CharacterStyleRange>",
    "</ParagraphStyleRange>",
    "</Story></idPkg:Story>",
  ].join("")
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}><idPkg:Story src="${STORY}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    "Resources/Styles.xml",
    `<?xml version="1.0"?><idPkg:Styles ${IDPKG}></idPkg:Styles>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(STORY, story, { compression: "DEFLATE", createFolders: false })
  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  })
}
