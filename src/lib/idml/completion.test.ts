import JSZip from "jszip"
import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  renderIdmlUnitHtml,
  validateIdmlTranslation,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import {
  IDML_COMPLETION_INSTRUCTION,
  IDML_STRUCTURE_REPAIR_INSTRUCTION,
  IdmlCompletionError,
  buildIdmlStructureRepairMessages,
  idmlCompletionPromptSource,
  idmlCompletionSystemAddendum,
  normalizeProtectedCompletion,
  normalizeProtectedCompletionWithRepair,
  parseIdmlSlotRepairReply,
  stitchIdmlSlotTexts,
  tryDeterministicIdmlSlotStitch,
  unwrapIdmlCompletionOutput,
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

  it("unwraps Markdown fences before validating protected HTML", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)
    const targetHtml = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot, index) => ({
        ...slot,
        text: index === 0 ? "Bon" : "JOUR",
      })),
    })

    expect(unwrapIdmlCompletionOutput(`\`\`\`html\n${targetHtml}\n\`\`\``)).toBe(targetHtml)
    expect(normalizeProtectedCompletion(cell, `\`\`\`html\n${targetHtml}\n\`\`\``)).toEqual({
      value: "Bon\nJOUR",
      valueHtml: targetHtml,
    })
  })

  it("stitches a single-slot plain draft into the source shell without a second model call", async () => {
    const unit = await parsedSingleSlotUnit()
    const cell = cellFor(unit)

    const stitched = tryDeterministicIdmlSlotStitch(cell, "Traduction en une seule cellule.")
    expect(stitched?.value).toBe("Traduction en une seule cellule.\n")
    expect(stitched?.valueHtml).toContain('data-idml-slot="0"')
    expect(stitched?.valueHtml).toContain("Traduction en une seule cellule.")

    const repair = vi.fn(async () => {
      throw new Error("repair must not run for single-slot plain text")
    })
    await expect(normalizeProtectedCompletionWithRepair(
      cell,
      "Traduction en une seule cellule.",
      repair,
    )).resolves.toMatchObject({ value: "Traduction en une seule cellule.\n" })
    expect(repair).not.toHaveBeenCalled()
  })

  it("repairs a multi-slot broken draft via slot-JSON, then stitches into the source shell", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)
    const repair = vi.fn(async (messages: readonly { role: string; content: string }[]) => {
      expect(messages[0]?.content).toBe(IDML_STRUCTURE_REPAIR_INSTRUCTION)
      expect(messages[1]?.content).toContain(unit.sourceHtml)
      expect(messages[1]?.content).toContain("EDITABLE SLOTS")
      expect(messages[1]?.content).toContain("plain broken draft")
      return JSON.stringify({ slots: [{ i: 0, t: "Bon" }, { i: 1, t: "JOUR" }] })
    })

    const result = await normalizeProtectedCompletionWithRepair(
      cell,
      "plain broken draft",
      repair,
    )
    expect(result.value).toBe("Bon\nJOUR")
    expect(result.valueHtml).toContain('data-idml-slot="0"')
    expect(result.valueHtml).toContain("Bon")
    expect(result.valueHtml).toContain("JOUR")
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it("does not call repair when the first draft already validates", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)
    const targetHtml = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot) => ({ ...slot, text: "ok" })),
    })
    const repair = vi.fn(async () => {
      throw new Error("repair must not run")
    })

    await expect(normalizeProtectedCompletionWithRepair(cell, targetHtml, repair))
      .resolves.toMatchObject({ valueHtml: targetHtml })
    expect(repair).not.toHaveBeenCalled()
  })

  it("surfaces the original failure when the repair pass is still invalid", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)
    const repair = vi.fn(async () => "still plain text")

    await expect(normalizeProtectedCompletionWithRepair(
      cell,
      "plain broken draft",
      repair,
    )).rejects.toThrow(/repair pass also failed/i)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it("parses slot-repair JSON and stitches it into the source shell", async () => {
    const unit = await parsedUnit()
    const cell = cellFor(unit)
    const slots = parseIdmlSlotRepairReply(
      '```json\n{"slots":[{"i":0,"t":"Bon"},{"i":1,"t":"JOUR"}]}\n```',
      unit.metadata.editableSlotIndexes,
    )
    expect([...slots.entries()]).toEqual([[0, "Bon"], [1, "JOUR"]])
    expect(stitchIdmlSlotTexts(cell, slots).value).toBe("Bon\nJOUR")
  })

  it("builds a repair prompt that includes source, slots, draft, and diagnostics", () => {
    const messages = buildIdmlStructureRepairMessages(
      '<p data-idml-version="2">src</p>',
      "broken",
      [{ code: "ANCHOR_INVALID", severity: "error", message: "IDML HTML is malformed" }],
      new Map([[0, "Hello"]]),
    )
    expect(messages[1]?.content).toContain("SOURCE")
    expect(messages[1]?.content).toContain('<p data-idml-version="2">src</p>')
    expect(messages[1]?.content).toContain("EDITABLE SLOTS")
    expect(messages[1]?.content).toContain("0: \"Hello\"")
    expect(messages[1]?.content).toContain("broken")
    expect(messages[1]?.content).toContain("ANCHOR_INVALID")
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
  return parseFixtureUnit([
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Hello</Content></CharacterStyleRange>',
    "<Br/>",
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>WORLD</Content></CharacterStyleRange>',
  ])
}

async function parsedSingleSlotUnit(): Promise<IdmlTranslationUnit> {
  return parseFixtureUnit([
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Hello world</Content></CharacterStyleRange>',
    "<Br/>",
  ])
}

async function parseFixtureUnit(inner: readonly string[]): Promise<IdmlTranslationUnit> {
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
      ...inner,
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
