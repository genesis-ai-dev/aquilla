import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import {
  exportIdml as exportWithSharedEngine,
  parseIdml,
  renderIdmlUnitHtml,
  validateExport,
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
    const missingTarget = cellFor(unit)
    missingTarget.translatedHtml = undefined
    const changedAnchor = cellFor(unit)
    changedAnchor.translatedHtml = changedAnchor.translatedHtml?.replace(
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

async function buildFixture(): Promise<ArrayBuffer> {
  const story = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<idPkg:Story ${IDPKG}><Story Self="u100">`,
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
