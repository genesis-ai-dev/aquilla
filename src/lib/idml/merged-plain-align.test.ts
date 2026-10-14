import { beforeEach, describe, expect, it } from "vitest"
import {
  idmlMergedPlainGroupCollapsed,
  rememberManualStyleAlignment,
  type MergedPlainAlignCell,
} from "./merged-plain-align"
import {
  resetStyleAlignDirtyForTests,
  styleAlignDirtyMatches,
} from "@/lib/store/style-align-dirty"

beforeEach(() => {
  localStorage.clear()
  resetStyleAlignDirtyForTests()
})

describe("merged plain runs that need Align styles", () => {
  it("is collapsed when consecutive plain runs were typed into one of them", () => {
    const cell = cellOf(
      paragraph(slot(0, "Plain", "Hello ") + slot(1, "Plain", "world")),
      paragraph(slot(0, "Plain", "Bonjour monde") + slot(1, "Plain", "")),
    )
    expect(idmlMergedPlainGroupCollapsed(cell)).toBe(true)
  })

  it("is not collapsed when each plain run the source uses still has text", () => {
    const cell = cellOf(
      paragraph(slot(0, "Plain", "Hello ") + slot(1, "Plain", "world")),
      paragraph(slot(0, "Plain", "Bonjour ") + slot(1, "Plain", "monde")),
    )
    expect(idmlMergedPlainGroupCollapsed(cell)).toBe(false)
  })

  it("ignores plain runs that bold, italic, or a token keeps visually separate", () => {
    const splitByBold = cellOf(
      paragraph(slot(0, "Plain", "Hello ") + slot(1, "Bold", "WORLD") + slot(2, "Plain", " said")),
      paragraph(slot(0, "Plain", "Bonjour monde") + slot(1, "Bold", "") + slot(2, "Plain", "")),
    )
    const splitByToken = cellOf(
      paragraph(slot(0, "Plain", "Hello ") + token() + slot(1, "Plain", "world")),
      paragraph(slot(0, "Plain", "Bonjour monde") + token() + slot(1, "Plain", "")),
    )
    const splitByItalic = cellOf(
      paragraph(slot(0, "Plain", "Hello ") + slot(1, "Italic", "world")),
      paragraph(slot(0, "Plain", "Bonjour monde") + slot(1, "Italic", "")),
    )
    expect(idmlMergedPlainGroupCollapsed(splitByBold)).toBe(false)
    expect(idmlMergedPlainGroupCollapsed(splitByToken)).toBe(false)
    expect(idmlMergedPlainGroupCollapsed(splitByItalic)).toBe(false)
  })

  it("does not warn when the source itself only fills one run of the group", () => {
    const cell = cellOf(
      paragraph(slot(0, "Plain", "Hello") + slot(1, "Plain", "")),
      paragraph(slot(0, "Plain", "Bonjour") + slot(1, "Plain", "")),
    )
    expect(idmlMergedPlainGroupCollapsed(cell)).toBe(false)
  })

  it("remembers a manual edit only while that HTML is still the collapsed one", () => {
    const collapsed = cellOf(
      paragraph(slot(0, "Plain", "Hello ") + slot(1, "Plain", "world")),
      paragraph(slot(0, "Plain", "Bonjour monde") + slot(1, "Plain", "")),
    )
    rememberManualStyleAlignment("cell-1", "Bonjour monde", collapsed)
    expect(styleAlignDirtyMatches("cell-1", collapsed.translatedHtml)).toBe(true)

    const split = {
      ...collapsed,
      translatedHtml: paragraph(slot(0, "Plain", "Bonjour ") + slot(1, "Plain", "monde")),
    }
    rememberManualStyleAlignment("cell-1", "Bonjour monde", split)
    expect(styleAlignDirtyMatches("cell-1", collapsed.translatedHtml)).toBe(false)
    expect(styleAlignDirtyMatches("cell-1", split.translatedHtml)).toBe(false)
  })
})

function cellOf(source: string, target: string): MergedPlainAlignCell {
  return {
    originalHtml: source,
    translatedHtml: target,
    metadata: {
      idml: {
        version: 2,
        editableSlotIndexes: [0, 1, 2],
      },
    },
  }
}

function paragraph(inner: string): string {
  return `<p data-idml-version="2">${inner}</p>`
}

function slot(index: number, face: "Plain" | "Bold" | "Italic", text: string): string {
  return `<span data-idml-slot="${index}" data-idml-character-style="CharacterStyle/${face}" data-idml-protected="slot">${text}</span>`
}

function token(): string {
  return `<span data-idml-token="0" data-idml-token-kind="tab" data-idml-protected="token"></span>`
}
