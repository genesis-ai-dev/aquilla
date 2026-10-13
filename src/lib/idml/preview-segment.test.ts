import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import {
  emptyIdmlEditableHtml,
  idmlTargetIsPreview,
  placeIdmlPreviewInOnlySlot,
} from "./preview-segment"

const BOLD = "CharacterStyle/Bold"
const PLAIN = "CharacterStyle/Plain"

function metadata(
  slots: { index: number; characterStyleId: string; editable: boolean }[],
): IdmlFormatMetadataV2 {
  return {
    version: 2,
    slotCount: slots.length,
    editableSlotIndexes: slots.filter((slot) => slot.editable).map((slot) => slot.index),
    protectedTokenCount: 0,
    anchorSequenceHash: createHash("sha256").update(
      slots.map((slot) => `slot:${slot.index}:${slot.editable ? "editable" : "locked"}:${slot.characterStyleId}`).join("\u0000"),
    ).digest("hex"),
  }
}

function slot(index: number, style: string, text: string, locked = false): string {
  const lock = locked ? ` contenteditable="false"` : ""
  return `<span data-idml-slot="${index}" data-idml-character-style="${style}" data-idml-protected="slot"${lock}>${text}</span>`
}

describe("IDML preview segment", () => {
  const twoRuns = metadata([
    { index: 0, characterStyleId: PLAIN, editable: true },
    { index: 1, characterStyleId: BOLD, editable: true },
  ])
  const meta = { idml: twoRuns }

  it("treats an untranslated cell as a preview, including a blank shell of the source runs", () => {
    const empty = `<p data-idml-version="2">${slot(0, PLAIN, "")}${slot(1, BOLD, "")}</p>`
    expect(idmlTargetIsPreview(undefined, meta)).toBe(true)
    expect(idmlTargetIsPreview(empty, meta)).toBe(true)
    expect(idmlTargetIsPreview(
      `<p data-idml-version="2">${slot(0, PLAIN, "Bonjour")}${slot(1, BOLD, "")}</p>`,
      meta,
    )).toBe(false)
    expect(idmlTargetIsPreview(empty, {})).toBe(false)
  })

  it("clears editable runs and keeps a locked run when building the preview shell", () => {
    const runs = metadata([
      { index: 0, characterStyleId: PLAIN, editable: true },
      { index: 1, characterStyleId: BOLD, editable: false },
    ])
    const source = `<p data-idml-version="2">${slot(0, PLAIN, "Hello")}${slot(1, BOLD, "LOCK", true)}</p>`
    const shell = emptyIdmlEditableHtml(source, runs)
    expect(shell).not.toContain("Hello")
    expect(shell).toContain("LOCK")
    expect(validateIdmlTranslation(source, shell, runs).valid).toBe(true)
  })

  it("places a one-run preview into that run", () => {
    const runs = metadata([{ index: 0, characterStyleId: BOLD, editable: true }])
    const source = `<p data-idml-version="2">${slot(0, BOLD, "Hello")}</p>`
    const placed = placeIdmlPreviewInOnlySlot({
      id: "cell-1",
      originalHtml: source,
      metadata: { idml: runs },
    }, "Bonjour")
    expect(placed.value).toBe("Bonjour")
    expect(placed.valueHtml).toContain(">Bonjour</span>")
    expect(validateIdmlTranslation(source, placed.valueHtml ?? "", runs).valid).toBe(true)
  })
})
