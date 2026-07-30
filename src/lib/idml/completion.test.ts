import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import {
  parseIdml,
  renderIdmlUnitHtml,
  validateIdmlTranslation,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import {
  IDML_COMPLETION_INSTRUCTION,
  IdmlCompletionError,
  idmlCompletionPromptSource,
  idmlCompletionSystemAddendum,
  normalizeProtectedCompletion,
} from "./completion"
import {
  ProtectedIdmlHtmlError,
  replaceProtectedIdmlText,
} from "./protected-html"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

describe("IDML AI completion contract", () => {
  it("sends canonical protected HTML plus an exact-anchor instruction", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)

    expect(idmlCompletionPromptSource(cell, unit.sourceText)).toBe(unit.sourceHtml)
    expect(idmlCompletionSystemAddendum([cell])).toBe(IDML_COMPLETION_INSTRUCTION)
  })

  it("accepts exact anchors, derives plain text, and preserves rich HTML for persistence", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)
    const targetHtml = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot, index) => ({
        ...slot,
        text: index === 0 ? "Bon" : "JOUR",
      })),
    })

    expect(normalizeProtectedCompletion(cell, targetHtml)).toEqual({
      value: "Bon\nJOUR",
      valueHtml: targetHtml,
    })
  })

  it("reconstructs a plain one-slot draft inside canonical protected HTML", async () => {
    const unit = await parsedSingleSlotUnit()
    const cell = {
      ...cellFor(unit),
      translatedHtml: renderIdmlUnitHtml({
        ...unit,
        slots: unit.slots.map((slot) => ({ ...slot, text: slot.editable ? "" : slot.text })),
      }),
    }

    const normalized = normalizeProtectedCompletion(cell, "Texte traduit")

    expect(normalized.value).toBe("Texte traduit\n")
    expect(normalized.valueHtml).toContain('data-idml-slot="0"')
    expect(normalized.valueHtml).toContain("Texte traduit")
    expect(validateIdmlTranslation(
      unit.sourceHtml,
      normalized.valueHtml!,
      unit.metadata,
    ).valid).toBe(true)
  })

  it("recovers one-slot prose from a damaged protected response without copying protected literals", async () => {
    const unit = await parsedSingleSlotUnit()
    const valid = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot) => ({ ...slot, text: slot.editable ? "Texte traduit" : slot.text })),
    })
    const damaged = valid.replace(/<span[^>]*data-idml-token[^>]*>.*?<\/span>/, "")

    const normalized = normalizeProtectedCompletion(cellFor(unit), damaged)

    expect(normalized.value).toBe("Texte traduit\n")
    expect(validateIdmlTranslation(
      unit.sourceHtml,
      normalized.valueHtml!,
      unit.metadata,
    ).valid).toBe(true)
  })

  it("reconstructs a multi-slot draft when slot identities survive a protected editability change", async () => {
    const unit = await parsedUnit()
    const generated = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot, index) => ({
        ...slot,
        text: index === 0 ? "Les livres" : "des prophètes",
      })),
    })
    const damaged = generated.replace(
      'data-idml-protected="slot"',
      'data-idml-protected="slot" contenteditable="false"',
    )
    expect(damaged).not.toBe(generated)

    const normalized = normalizeProtectedCompletion(cellFor(unit), damaged)

    expect(normalized.value).toBe("Les livres\ndes prophètes")
    expect(validateIdmlTranslation(
      unit.sourceHtml,
      normalized.valueHtml!,
      unit.metadata,
    ).valid).toBe(true)
  })

  it("rejects ambiguous multi-slot output with missing or duplicate editable anchors", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)
    const valid = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot) => ({ ...slot, text: "traduit" })),
    })
    const invalid = [
      "plain translated text",
      valid.replace('data-idml-slot="0"', 'data-idml-slot="9"'),
      valid.replace(
        "</p>",
        '<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Plain" data-idml-protected="slot">duplicate</span></p>',
      ),
    ]

    for (const generated of invalid) {
      expect(() => normalizeProtectedCompletion(cell, generated))
        .toThrow(IdmlCompletionError)
    }
  })

  it("leaves ordinary completion output byte-for-byte unchanged", () => {
    const cell = { id: "plain", originalHtml: "<p>source</p>", metadata: {} }
    expect(normalizeProtectedCompletion(cell, "ordinary result")).toEqual({
      value: "ordinary result",
    })
    expect(idmlCompletionPromptSource(cell, "source")).toBe("source")
    expect(idmlCompletionSystemAddendum([cell])).toBeUndefined()
  })

  it("rejects unsupported future metadata instead of treating it as generic text", () => {
    const cell = {
      id: "future",
      originalHtml: '<p data-idml-version="3">source</p>',
      metadata: { idml: { version: 3 } },
    }
    expect(() => idmlCompletionPromptSource(cell, "source")).toThrow(/unsupported IDML metadata version 3/i)
    expect(() => normalizeProtectedCompletion(cell, "plain output")).toThrow(IdmlCompletionError)
  })
})

describe("IDML protected find/replace", () => {
  it("replaces within editable slots while preserving style and token anchors", async () => {
    const unit = await parsedUnit()
    const targetHtml = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot, index) => ({
        ...slot,
        text: index === 0 ? "Hello" : "WORLD",
      })),
    })
    const cell = { ...cellFor(unit), translatedHtml: targetHtml }

    const replaced = replaceProtectedIdmlText(cell, "O", "o", "Hello\nWoRLD")

    expect(replaced.value).toBe("Hello\nWoRLD")
    expect(replaced.valueHtml).toContain('data-idml-character-style="CharacterStyle/Plain"')
    expect(replaced.valueHtml).toContain('data-idml-character-style="CharacterStyle/Bold"')
    expect(replaced.valueHtml).toContain('data-idml-token-kind="br"')
  })

  it("rejects a replacement whose match would cross a protected boundary", async () => {
    const unit = await parsedUnit()
    const targetHtml = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot, index) => ({
        ...slot,
        text: index === 0 ? "Hello" : "WORLD",
      })),
    })
    const cell = { ...cellFor(unit), translatedHtml: targetHtml }

    expect(() => replaceProtectedIdmlText(
      cell,
      "o\nW",
      "X",
      "HellXORLD",
    )).toThrow(ProtectedIdmlHtmlError)
  })

  it("routes future IDML metadata into the protected path and fails closed", () => {
    const cell = {
      id: "future",
      originalHtml: '<p data-idml-version="3">source</p>',
      translatedHtml: '<p data-idml-version="3">target</p>',
      metadata: { idml: { version: 3 } },
    }
    expect(() => replaceProtectedIdmlText(cell, "target", "changed"))
      .toThrow(/unsupported IDML metadata version 3/i)
  })
})

function cellFor(unit: IdmlTranslationUnit) {
  return {
    id: unit.id,
    originalHtml: unit.sourceHtml,
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
      "<Br/>",
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
  if (!unit) throw new Error("Missing IDML completion fixture unit")
  return unit
}

async function parsedSingleSlotUnit(): Promise<IdmlTranslationUnit> {
  const storyPath = "Stories/Story_u363.xml"
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
      `<?xml version="1.0"?><idPkg:Story ${IDPKG}><Story Self="u363">`,
      '<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Hello world</Content></CharacterStyleRange>',
      "<Br/>",
      "</ParagraphStyleRange></Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  const parsed = await parseIdml(await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  }))
  const unit = parsed.units[0]
  if (!unit) throw new Error("Missing one-slot IDML completion fixture unit")
  return unit
}
