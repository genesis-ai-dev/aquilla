import JSZip from "jszip"
import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  renderIdmlUnitHtml,
  validateIdmlTranslation,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  alignReimportedIdmlTargets,
  commitsForAlignedIdmlTargets,
  idmlReimportPlacement,
  pairedCellsForIdmlAlignment,
  type IdmlReimportAlignCell,
} from "./align-reimported-targets"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

describe("IDML re-import style alignment", () => {
  it("places a legacy translation into the source runs and chains the commit on the existing target", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const cell = legacyCell(unit, "cell-1", "Bonjour MONDE")
    const ask = vi.fn().mockResolvedValue(JSON.stringify({
      slots: [{ i: 0, t: "Bonjour " }, { i: 1, t: "MONDE" }],
    }))

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(ask).toHaveBeenCalledOnce()
    expect(outcome.failed).toBe(0)
    expect(outcome.aligned).toHaveLength(1)
    const html = outcome.aligned[0]!.completion.valueHtml!
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("Bonjour ")
    expect(checked.slots[1]).toBe("MONDE")

    const [commit] = commitsForAlignedIdmlTargets(outcome.aligned, {
      projectId: "project",
      fileId: "file",
      author: "frontier-default",
      model: "frontier-default",
      provider: "frontier",
      sourceLanguage: "en",
      targetLanguage: "pt",
    })
    expect(commit?.cellId).toBe("cell-1")
    expect(commit?.parentId).toBe("target-event")
    expect(commit?.sourceEventId).toBe("source-event")
    expect(commit?.valueHtml).toBe(html)
    expect(commit?.aiDraft?.mode).toBe("align-styles")
    expect(commit?.value.replace(/\s+/g, " ").trim()).toBe("Bonjour MONDE")
  })

  it("keeps the translation when the model changes the wording, and still aligns the next cell", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const broken = legacyCell(unit, "broken", "Bonjour MONDE")
    const kept = legacyCell(unit, "kept", "disse o Senhor")
    const ask = vi.fn(async (messages: readonly { content: string }[]) => {
      const wording = messages[1]?.content ?? ""
      if (wording.includes("Bonjour MONDE")) {
        return JSON.stringify({ slots: [{ i: 0, t: "Olá " }, { i: 1, t: "MUNDO" }] })
      }
      return JSON.stringify({ slots: [{ i: 0, t: "disse " }, { i: 1, t: "o Senhor" }] })
    })

    const outcome = await alignReimportedIdmlTargets([broken, kept], ask, { concurrency: 1 })

    expect(outcome.failed).toBe(0)
    expect(outcome.aligned.map((entry) => entry.cell.id)).toEqual(["broken", "kept"])
    const brokenHtml = outcome.aligned[0]!.completion.valueHtml!
    const brokenSlots = validateIdmlTranslation(unit.sourceHtml, brokenHtml, unit.metadata)
    expect(brokenSlots.valid).toBe(true)
    expect(brokenSlots.slots.join("")).toContain("Bonjour MONDE")
    expect(brokenSlots.slots.join("")).not.toContain("Olá")
    expect(outcome.aligned[1]!.completion.value.replace(/\s+/g, " ").trim()).toBe("disse o Senhor")
  })

  it("does not call the model for a target that already matches the new source", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const cell: IdmlReimportAlignCell = {
      ...legacyCell(unit, "ready", "Bonjour MONDE"),
      translatedHtml: renderIdmlUnitHtml({
        ...unit,
        slots: unit.slots.map((slot, index) => ({
          ...slot,
          text: index === 0 ? "Bonjour " : "MONDE",
        })),
      }),
    }
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(idmlReimportPlacement(cell)).toBe("current")
    expect(ask).not.toHaveBeenCalled()
    expect(outcome.aligned).toHaveLength(0)
    expect(outcome.unchanged).toBe(1)
  })

  it("stitches a one-run translation without a model call", async () => {
    const unit = await parsedUnit(["Hello WORLD"])
    const cell = legacyCell(unit, "single", "Bonjour MONDE")
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(idmlReimportPlacement(cell)).toBe("single")
    expect(ask).not.toHaveBeenCalled()
    expect(outcome.aligned).toHaveLength(1)
    const html = outcome.aligned[0]!.completion.valueHtml!
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots.join("")).toBe("Bonjour MONDE")
  })

  it("stops before the next cell when alignment is cancelled", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const controller = new AbortController()
    const ask = vi.fn(async () => {
      controller.abort()
      return JSON.stringify({ slots: [{ i: 0, t: "Bonjour " }, { i: 1, t: "MONDE" }] })
    })

    const outcome = await alignReimportedIdmlTargets(
      [legacyCell(unit, "first", "Bonjour MONDE"), legacyCell(unit, "second", "Bonjour MONDE")],
      ask,
      { concurrency: 1, signal: controller.signal },
    )

    expect(ask).toHaveBeenCalledOnce()
    expect(outcome.aligned.map((entry) => entry.cell.id)).toEqual(["first"])
  })

  it("pairs the new source with the translation on the same lane", () => {
    const cells = pairedCellsForIdmlAlignment([
      row("source", "cell-1", "source-event", "<p>new</p>", "Hello"),
      row("target", "cell-1", "target-event", "<p>old</p>", "Olá", ""),
      row("target", "cell-1", "other-event", "<p>other</p>", "Hola", "es"),
    ])

    expect(cells).toEqual([expect.objectContaining({
      id: "cell-1",
      originalHtml: "<p>new</p>",
      translated: "Olá",
      translatedHtml: "<p>old</p>",
      sourceEventId: "source-event",
      targetEventId: "target-event",
    })])
  })
})

function legacyCell(unit: IdmlTranslationUnit, id: string, translated: string): IdmlReimportAlignCell {
  return {
    id,
    originalHtml: unit.sourceHtml,
    translated,
    translatedHtml: `<p>${translated}</p>`,
    metadata: { idml: unit.metadata },
    sourceEventId: "source-event",
    targetEventId: "target-event",
  }
}

function row(
  side: "source" | "target",
  cellId: string,
  eventId: string,
  valueHtml: string,
  value: string,
  targetLang = "",
): CellRow {
  return {
    cellId,
    side,
    targetLang,
    value,
    valueHtml,
    type: "text",
    canonicalRef: null,
    anchorCellId: null,
    eventId,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 1,
  }
}

async function parsedUnit(runs: readonly string[]): Promise<IdmlTranslationUnit> {
  const storyPath = "Stories/Story_u100.xml"
  const ranges = runs.map((text, index) => {
    const style = index === 0 ? "CharacterStyle/Plain" : "CharacterStyle/Bold"
    return `<CharacterStyleRange AppliedCharacterStyle="${style}"><Content>${text}</Content></CharacterStyleRange>`
  }).join("")
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
      ranges,
      "</ParagraphStyleRange></Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  const parsed = await parseIdml(await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  }))
  const unit = parsed.units[0]
  if (!unit) throw new Error("Missing IDML re-import fixture unit")
  return unit
}
