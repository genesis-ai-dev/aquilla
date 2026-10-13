/**
 * Consecutive plain IDML runs are drawn as one segment. Typing into that
 * segment puts the words into whichever run holds the caret and leaves the
 * others empty. That is the only case the corner warning is for: the source
 * uses several of those runs, and the typed translation uses fewer of them.
 *
 * Bold, italic, and tokens break the group, matching the on-screen join.
 */

import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"
import { idmlCharacterStyleEmphasis } from "@/lib/richtext/idml-style-display"
import {
  idmlParagraphStyleFromMetadata,
  idmlStyleCatalogFromMetadata,
  type IdmlStyleCatalog,
} from "@/lib/idml/style-catalog"
import {
  clearStyleAlignDirty,
  markStyleAlignDirty,
} from "@/lib/store/style-align-dirty"

export interface MergedPlainAlignCell {
  readonly originalHtml?: string
  readonly translatedHtml?: string
  readonly metadata?: Record<string, unknown> | null
}

/**
 * Record a human edit. A collapsed merged plain group is remembered against
 * this exact HTML; a split that already fills the source's runs clears it.
 */
export function rememberManualStyleAlignment(
  cellId: string,
  plain: string,
  cell: MergedPlainAlignCell,
): void {
  const html = cell.translatedHtml ?? ""
  if (plain.trim() && html && idmlMergedPlainGroupCollapsed(cell)) {
    markStyleAlignDirty(cellId, html)
  } else {
    clearStyleAlignDirty(cellId)
  }
}

export function idmlMergedPlainGroupCollapsed(cell: MergedPlainAlignCell): boolean {
  const editable = editableSlotIndexes(cell.metadata)
  if (!editable || !cell.originalHtml || !cell.translatedHtml) return false
  if (typeof document === "undefined") return false

  const sourceTexts = readSlotTexts(cell.originalHtml)
  const targetTexts = readSlotTexts(cell.translatedHtml)
  const catalog = idmlStyleCatalogFromMetadata(cell.metadata)
  const paragraphStyleId = idmlParagraphStyleFromMetadata(cell.metadata)

  for (const group of plainGroups(cell.originalHtml, catalog, paragraphStyleId)) {
    if (group.length < 2) continue
    const runs = group.filter((index) => editable.has(index))
    if (runs.length < 2) continue
    const sourceFilled = runs.filter((index) => hasWords(sourceTexts.get(index))).length
    if (sourceFilled < 2) continue
    const targetFilled = runs.filter((index) => hasWords(targetTexts.get(index))).length
    if (targetFilled > 0 && targetFilled < sourceFilled) return true
  }
  return false
}

function editableSlotIndexes(
  metadata: Record<string, unknown> | null | undefined,
): Set<number> | undefined {
  const candidate = metadata?.idml
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined
  if ((candidate as { version?: unknown }).version !== 2) return undefined
  const indexes = (candidate as { editableSlotIndexes?: unknown }).editableSlotIndexes
  if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index))) return undefined
  return new Set(indexes as number[])
}

function plainGroups(
  html: string,
  catalog: IdmlStyleCatalog | undefined,
  paragraphStyleId: string | undefined,
): number[][] {
  const groups: number[][] = []
  const container = document.createElement("div")
  container.innerHTML = sanitizeIdmlEditorHtml(html)
  const paragraph = container.querySelector("p") ?? container
  let current: number[] = []
  const close = () => {
    if (current.length > 0) groups.push(current)
    current = []
  }
  for (const child of paragraph.children) {
    if (!(child instanceof HTMLElement)) continue
    const index = slotIndex(child)
    if (index === null || !slotIsPlain(child, catalog, paragraphStyleId)) {
      close()
      continue
    }
    current.push(index)
  }
  close()
  return groups
}

function slotIndex(element: HTMLElement): number | null {
  if (element.getAttribute("data-idml-protected") !== "slot") return null
  const index = Number(element.getAttribute("data-idml-slot"))
  return Number.isInteger(index) ? index : null
}

function slotIsPlain(
  slot: HTMLElement,
  catalog: IdmlStyleCatalog | undefined,
  paragraphStyleId: string | undefined,
): boolean {
  const styleId = slot.getAttribute("data-idml-character-style") ?? ""
  const inherit = Boolean(paragraphStyleId) && isDefaultCharacterStyle(styleId)
  const { bold, italic } = idmlCharacterStyleEmphasis(
    inherit ? paragraphStyleId! : styleId,
    catalog,
  )
  return !bold && !italic
}

function isDefaultCharacterStyle(styleId: string): boolean {
  if (!styleId) return true
  return styleId.includes("[No character style]")
}

function readSlotTexts(html: string): Map<number, string> {
  const texts = new Map<number, string>()
  const container = document.createElement("div")
  container.innerHTML = sanitizeIdmlEditorHtml(html)
  for (const slot of container.querySelectorAll<HTMLElement>("span[data-idml-slot]")) {
    const index = Number(slot.getAttribute("data-idml-slot"))
    if (!Number.isInteger(index)) continue
    texts.set(index, (slot.textContent ?? "").replace(/\u200b/g, ""))
  }
  return texts
}

function hasWords(text: string | undefined): boolean {
  return Boolean(text?.replace(/\u00a0/g, " ").trim())
}
