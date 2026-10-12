import JSZip from "jszip"
import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  renderIdmlUnitHtml,
  validateIdmlTranslation,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import {
  alignIdmlStyles,
  buildIdmlAlignStylesMessages,
  cellCanAlignStyles,
  type AlignStylesCell,
} from "./align-styles"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

describe("align IDML styles", () => {
  it("offers alignment only for a multi-run IDML cell", async () => {
    const unit = await parsedUnit()
    const cell = misalignedCell(unit)
    expect(cellCanAlignStyles(cell)).toBe(true)
    expect(cellCanAlignStyles({ ...cell, metadata: { idml: { ...unit.metadata, editableSlotIndexes: [0] } } })).toBe(false)
    expect(cellCanAlignStyles({ ...cell, metadata: {} })).toBe(false)
    expect(cellCanAlignStyles({ ...cell, originalHtml: undefined })).toBe(false)
  })

  it("describes source runs and the current wording without asking for a new translation", async () => {
    const unit = await parsedUnit()
    const messages = buildIdmlAlignStylesMessages(misalignedCell(unit))
    expect(messages[0]?.content).toContain("Do not translate")
    expect(messages[1]?.content).toContain("bold")
    expect(messages[1]?.content).toContain("WORLD")
    expect(messages[1]?.content).toContain("Bonjour MONDE")
    expect(messages[1]?.content).not.toContain("protected-anchor")
  })

  it("moves existing words into the bold run and keeps the source structure", async () => {
    const unit = await parsedUnit()
    const cell = misalignedCell(unit)
    const ask = vi.fn().mockResolvedValue(JSON.stringify({
      slots: [{ i: 0, t: "Bonjour " }, { i: 1, t: "MONDE" }],
    }))

    const aligned = await alignIdmlStyles(cell, ask)

    expect(aligned.changed).toBe(true)
    expect(aligned.completion.valueHtml).toBeDefined()
    const checked = validateIdmlTranslation(unit.sourceHtml, aligned.completion.valueHtml!, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("Bonjour ")
    expect(checked.slots[1]).toBe("MONDE")
    const container = document.createElement("div")
    container.innerHTML = aligned.completion.valueHtml!
    expect(container.querySelector('[data-idml-character-style="CharacterStyle/Bold"]')?.textContent).toBe("MONDE")
    expect(container.querySelector('[data-idml-character-style="CharacterStyle/Plain"]')?.textContent).toBe("Bonjour ")
  })

  it("refuses a placement that rewrites the translation", async () => {
    const unit = await parsedUnit()
    const ask = vi.fn().mockResolvedValue(JSON.stringify({
      slots: [{ i: 0, t: "Bonjour " }, { i: 1, t: "LE MONDE" }],
    }))
    await expect(alignIdmlStyles(misalignedCell(unit), ask)).rejects.toThrow(/changed the wording/)
  })

  it("reports when the model leaves the runs as they are", async () => {
    const unit = await parsedUnit()
    const ask = vi.fn().mockResolvedValue(JSON.stringify({
      slots: [{ i: 0, t: "Bonjour MONDE" }, { i: 1, t: "" }],
    }))
    const aligned = await alignIdmlStyles(misalignedCell(unit), ask)
    expect(aligned.changed).toBe(false)
  })

  it("does not call the model when the cell has no translation", async () => {
    const unit = await parsedUnit()
    const ask = vi.fn()
    const cell: AlignStylesCell = {
      ...misalignedCell(unit),
      translated: "",
      translatedHtml: renderIdmlUnitHtml({
        ...unit,
        slots: unit.slots.map((slot) => ({ ...slot, text: slot.editable ? "" : slot.text })),
      }),
    }
    await expect(alignIdmlStyles(cell, ask)).rejects.toThrow(/before aligning/)
    expect(ask).not.toHaveBeenCalled()
  })
})

function misalignedCell(unit: IdmlTranslationUnit): AlignStylesCell {
  const translatedHtml = renderIdmlUnitHtml({
    ...unit,
    slots: unit.slots.map((slot, index) => ({
      ...slot,
      text: index === 0 ? "Bonjour MONDE" : "",
    })),
  })
  return {
    id: unit.id,
    originalHtml: unit.sourceHtml,
    translated: "Bonjour MONDE",
    translatedHtml,
    metadata: { idml: unit.metadata },
  }
}

async function parsedUnit(): Promise<IdmlTranslationUnit> {
  const storyPath = "Stories/Story_u100.xml"
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0"?><Document ${IDPKG}><idPkg:Story src="${storyPath}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    storyPath,
    [
      `<?xml version="1.0"?><idPkg:Story ${IDPKG}><Story Self="u100">`,
      '<ParagraphStyleRange Self="mixed" AppliedParagraphStyle="ParagraphStyle/Body">',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Hello</Content></CharacterStyleRange>',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>WORLD</Content></CharacterStyleRange>',
      "</ParagraphStyleRange></Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  const parsed = await parseIdml(await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  }))
  const unit = parsed.units[0]
  if (!unit) throw new Error("Missing IDML align-styles fixture unit")
  return unit
}
