import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { idmlTargetIsPreview } from "@/lib/idml/preview-segment"
import { placeIdmlTranslationsForPreview } from "./idml-placement"

const slot = (index: number, text: string, style = "CharacterStyle/Body") =>
  `<span data-idml-slot="${index}" data-idml-character-style="${style}" data-idml-protected="slot">${text}</span>`
const para = (...slots: string[]) => `<p data-idml-version="2">${slots.join("")}</p>`

/** The contract an import stores for a line whose runs are all editable. */
function contract(originalHtml: string, editable: number[]) {
  const styles = Array.from(originalHtml.matchAll(/data-idml-character-style="([^"]+)"/g)).map((m) => m[1])
  return {
    version: 2,
    slotCount: styles.length,
    editableSlotIndexes: editable,
    protectedTokenCount: 0,
    anchorSequenceHash: createHash("sha256")
      .update(styles.map((style, index) => `slot:${index}:editable:${style}`).join("\u0000"))
      .digest("hex"),
  }
}

function cell(id: string, originalHtml: string, editable: number[], translated: string, translatedHtml?: string): CellData {
  return {
    id,
    original: "source",
    originalHtml,
    translated,
    translatedHtml,
    group: id,
    type: "paragraph",
    metadata: { idml: contract(originalHtml, editable) },
  } as unknown as CellData
}

/** The words inside the editable runs of a target, in order. */
function runs(html: string | undefined): string[] {
  const doc = new DOMParser().parseFromString(html ?? "", "text/html")
  return Array.from(doc.querySelectorAll("[data-idml-slot]")).map((el) => el.textContent ?? "")
}

describe("placeIdmlTranslationsForPreview", () => {
  // The editor saves a freshly typed line as words beside empty runs. The
  // export refuses that, so without this every line being typed would freeze
  // the preview on its last good version.
  it("puts a typed sentence into the only style run, so the line can be exported", () => {
    const source = para(slot(0, "threaded frames"))
    const typed = cell("a", source, [0], "marcos enlazados", para(slot(0, "")))
    const { cells, approximated } = placeIdmlTranslationsForPreview([typed])
    expect(runs(cells[0].translatedHtml)).toEqual(["marcos enlazados"])
    expect(idmlTargetIsPreview(cells[0].translatedHtml, cells[0].metadata)).toBe(false)
    expect(approximated).toBe(0)
  })

  // Which words are bold is a translator's call. The preview must show the
  // words, and must say that their styling is a guess.
  it("shows a sentence with several style runs in the first, and counts it", () => {
    const source = para(slot(0, "Bold", "CharacterStyle/Bold"), slot(1, " and plain"))
    const typed = cell("a", source, [0, 1], "Negrita y normal", para(slot(0, "", "CharacterStyle/Bold"), slot(1, "")))
    const { cells, approximated } = placeIdmlTranslationsForPreview([typed])
    expect(runs(cells[0].translatedHtml)).toEqual(["Negrita y normal", ""])
    expect(approximated).toBe(1)
  })

  // Placement is for the picture only: the cells the editor holds are the
  // translator's, and a translation already in its runs is theirs to keep.
  it("leaves placed and untranslated lines, and the caller's cells, as they are", () => {
    const source = para(slot(0, "one"))
    const placed = cell("a", source, [0], "uno", para(slot(0, "uno")))
    const empty = cell("b", source, [0], "", undefined)
    const typed = cell("c", source, [0], "tres", para(slot(0, "")))
    const input = [placed, empty, typed]
    const { cells } = placeIdmlTranslationsForPreview(input)
    expect(cells[0]).toBe(placed)
    expect(cells[1]).toBe(empty)
    expect(typed.translatedHtml).toBe(para(slot(0, "")))
    expect(input[2]).toBe(typed)
  })
})
