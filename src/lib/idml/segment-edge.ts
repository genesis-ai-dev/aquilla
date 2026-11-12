/**
 * Dragging the edge of a bold or italic run moves whole words between that
 * run and the plain runs beside it. Punctuation is its own stop, so the edge
 * can sit between a word and the mark attached to it. The words stay in the
 * cell; only which run owns them changes. A locked run, a token, another
 * emphasis run, or a line break stops the edge.
 */

import type { IdmlStyleCatalog } from "@aquilla/idml-roundtrip"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"
import { idmlCharacterStyleEmphasis } from "@/lib/richtext/idml-style-display"

export type SegmentEdge = "start" | "end"

export type SegmentPiece =
  | { kind: "barrier" }
  | {
    kind: "slot"
    index: number
    text: string
    emphasis: boolean
    editable: boolean
    /** A line break lives here, so an edge cannot travel through this slot. */
    broken: boolean
  }

export interface SegmentEdgeContext {
  catalog?: IdmlStyleCatalog
  paragraphStyleId?: string
}

interface EmphasisRegion {
  slots: Extract<SegmentPiece, { kind: "slot" }>[]
  /** Index of the emphasis slot inside `slots`. */
  emphasisAt: number
}

function isDefaultCharacterStyle(styleId: string): boolean {
  if (!styleId) return true
  return styleId.includes("[No character style]")
}

export function slotEmphasis(
  styleId: string,
  context?: SegmentEdgeContext,
): boolean {
  const paragraphStyleId = context?.paragraphStyleId
  const inherit = Boolean(paragraphStyleId) && isDefaultCharacterStyle(styleId)
  const face = idmlCharacterStyleEmphasis(
    inherit ? paragraphStyleId! : styleId,
    context?.catalog,
  )
  return face.bold || face.italic
}

function isTravelSlot(piece: SegmentPiece): piece is Extract<SegmentPiece, { kind: "slot" }> {
  return piece.kind === "slot" && piece.editable && !piece.emphasis && !piece.broken
}

function isDragTarget(piece: SegmentPiece): piece is Extract<SegmentPiece, { kind: "slot" }> {
  return piece.kind === "slot" && piece.editable && piece.emphasis && !piece.broken
}

/**
 * The plain runs an edge can give words to or take words from, plus the
 * emphasis run itself. Null when that side has no plain run to exchange with.
 */
export function segmentEdgeRegion(
  pieces: readonly SegmentPiece[],
  slotIndex: number,
  edge: SegmentEdge,
): EmphasisRegion | null {
  const at = pieces.findIndex((piece) => piece.kind === "slot" && piece.index === slotIndex)
  const target = at >= 0 ? pieces[at] : undefined
  if (!target || !isDragTarget(target)) return null

  if (edge === "start") {
    const plain: Extract<SegmentPiece, { kind: "slot" }>[] = []
    for (let index = at - 1; index >= 0; index -= 1) {
      const piece = pieces[index]
      if (!piece || !isTravelSlot(piece)) break
      plain.unshift(piece)
    }
    if (plain.length === 0) return null
    return { slots: [...plain, target], emphasisAt: plain.length }
  }

  const plain: Extract<SegmentPiece, { kind: "slot" }>[] = []
  for (let index = at + 1; index < pieces.length; index += 1) {
    const piece = pieces[index]
    if (!piece || !isTravelSlot(piece)) break
    plain.push(piece)
  }
  if (plain.length === 0) return null
  return { slots: [target, ...plain], emphasisAt: 0 }
}

function codePointAt(text: string, index: number): string {
  const point = text.codePointAt(index)
  return point === undefined ? "" : String.fromCodePoint(point)
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char)
}

/** An apostrophe or hyphen only stays inside a word when a letter follows it. */
function isIntraWordJoiner(char: string): boolean {
  return char === "'" || char === "\u2019" || char === "\u02BC"
    || char === "-" || char === "\u2010" || char === "\u2011"
}

function readWord(text: string, index: number): number {
  let cursor = index
  while (cursor < text.length) {
    const char = codePointAt(text, cursor)
    if (isWordChar(char) || /\p{M}/u.test(char)) {
      cursor += char.length
      continue
    }
    if (!isIntraWordJoiner(char) || !isWordChar(codePointAt(text, cursor + char.length))) break
    cursor += char.length
  }
  return cursor
}

function readPunctuation(text: string, index: number): number {
  let cursor = index
  while (cursor < text.length) {
    const char = codePointAt(text, cursor)
    if (char === "" || /\s/u.test(char) || isWordChar(char)) break
    cursor += char.length
  }
  return cursor
}

/**
 * Character offsets a drag may snap to. The start edge snaps to the start of
 * a word or a punctuation run; the end edge snaps to the end of either.
 * "fox." can therefore end on the x, with the period left outside the box.
 */
export function wordBoundaryOffsets(text: string, edge: SegmentEdge): number[] {
  const offsets: number[] = []
  let index = 0
  while (index < text.length) {
    const char = codePointAt(text, index)
    if (char === "" || /\s/u.test(char)) {
      index += Math.max(char.length, 1)
      continue
    }
    const start = index
    index = isWordChar(char) ? readWord(text, index) : readPunctuation(text, index)
    offsets.push(edge === "start" ? start : index)
  }
  const cap = edge === "start" ? text.length : 0
  if (!offsets.includes(cap)) offsets.push(cap)
  offsets.sort((left, right) => left - right)
  return offsets
}

function regionText(region: EmphasisRegion): string {
  return region.slots.map((slot) => slot.text).join("")
}

function currentBoundary(region: EmphasisRegion, edge: SegmentEdge): number {
  if (edge === "start") {
    return region.slots
      .slice(0, region.emphasisAt)
      .reduce((sum, slot) => sum + slot.text.length, 0)
  }
  return region.slots[region.emphasisAt]?.text.length ?? 0
}

/**
 * Keep the far plain slots character-for-character. The slot that touches the
 * emphasis run absorbs whatever words crossed the edge.
 */
function assignPlain(original: readonly string[], plainText: string, edge: SegmentEdge): string[] {
  if (original.length === 0) return []
  if (original.length === 1) return [plainText]
  const out = original.map(() => "")
  if (edge === "start") {
    let consumed = 0
    let seam = original.length - 1
    for (let index = 0; index < original.length - 1; index += 1) {
      const part = original[index] ?? ""
      if (consumed + part.length <= plainText.length && plainText.startsWith(part, consumed)) {
        out[index] = part
        consumed += part.length
        continue
      }
      seam = index
      break
    }
    out[seam] = plainText.slice(consumed)
    return out
  }

  let consumed = 0
  let seam = 0
  for (let index = original.length - 1; index > 0; index -= 1) {
    const part = original[index] ?? ""
    const start = plainText.length - consumed - part.length
    if (start >= 0 && plainText.slice(start, start + part.length) === part) {
      out[index] = part
      consumed += part.length
      continue
    }
    seam = index
    break
  }
  out[seam] = plainText.slice(0, plainText.length - consumed)
  return out
}

/**
 * Move the emphasis run's edge to `boundary`, a character offset in the
 * concatenated text of the runs that edge can travel through. Returns the
 * slots whose text changed, or null when the boundary is already there.
 */
export function reflowSegmentEdge(
  pieces: readonly SegmentPiece[],
  slotIndex: number,
  edge: SegmentEdge,
  boundary: number,
): Map<number, string> | null {
  if (!Number.isInteger(boundary) || boundary < 0) return null
  const region = segmentEdgeRegion(pieces, slotIndex, edge)
  if (!region) return null
  const text = regionText(region)
  if (boundary > text.length || boundary === currentBoundary(region, edge)) return null

  const emphasis = region.slots[region.emphasisAt]
  if (!emphasis) return null
  const plainSlots = edge === "start"
    ? region.slots.slice(0, region.emphasisAt)
    : region.slots.slice(region.emphasisAt + 1)
  const plainText = edge === "start" ? text.slice(0, boundary) : text.slice(boundary)
  const emphasisText = edge === "start" ? text.slice(boundary) : text.slice(0, boundary)
  const plainAssigned = assignPlain(plainSlots.map((slot) => slot.text), plainText, edge)

  const updates = new Map<number, string>()
  plainSlots.forEach((slot, index) => {
    const next = plainAssigned[index] ?? ""
    if (next !== slot.text) updates.set(slot.index, next)
  })
  if (emphasisText !== emphasis.text) updates.set(emphasis.index, emphasisText)
  return updates.size > 0 ? updates : null
}

function readNodeText(element: HTMLElement): { text: string; broken: boolean } {
  let text = ""
  let broken = false
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent ?? "").replace(/\u200b/g, "")
      continue
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      broken = true
      text += "\n"
    }
  }
  return { text, broken }
}

function slotPiece(element: HTMLElement, context?: SegmentEdgeContext): Extract<SegmentPiece, { kind: "slot" }> | null {
  const index = Number(element.getAttribute("data-idml-slot"))
  const styleId = element.getAttribute("data-idml-character-style") ?? ""
  if (!Number.isInteger(index) || !styleId) return null
  const { text, broken } = readNodeText(element)
  return {
    kind: "slot",
    index,
    text,
    emphasis: slotEmphasis(styleId, context),
    editable: element.getAttribute("contenteditable") !== "false",
    broken,
  }
}

/** Read a protected IDML paragraph in document order. Tokens are barriers. */
export function readSegmentPiecesFromHtml(
  html: string,
  context?: SegmentEdgeContext,
): SegmentPiece[] {
  if (typeof document === "undefined") return []
  const template = document.createElement("template")
  template.innerHTML = sanitizeIdmlEditorHtml(html)
  const paragraph = template.content.querySelector("p") ?? template.content
  const pieces: SegmentPiece[] = []
  for (const child of paragraph.children) {
    if (!(child instanceof HTMLElement)) continue
    const kind = child.getAttribute("data-idml-protected")
    if (kind === "token") {
      pieces.push({ kind: "barrier" })
      continue
    }
    if (kind !== "slot") continue
    const piece = slotPiece(child, context)
    if (piece) pieces.push(piece)
  }
  return pieces
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
}

function serializeSlotInner(slot: HTMLElement): string {
  let html = ""
  for (const node of slot.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      html += escapeText((node.textContent ?? "").replace(/\u200b/g, ""))
    } else if (node instanceof HTMLElement && node.tagName === "BR") {
      html += "<br>"
    }
  }
  return html
}

function writeSlotText(slot: HTMLElement, text: string): void {
  slot.replaceChildren()
  const parts = text.split("\n")
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) slot.append(document.createElement("br"))
    const part = parts[index] ?? ""
    if (part.length > 0) slot.append(document.createTextNode(part))
  }
}

function serializeProtectedParagraph(paragraph: HTMLElement): string | null {
  if (paragraph.getAttribute("data-idml-version") !== "2") return null
  let html = `<p data-idml-version="2">`
  for (const child of paragraph.children) {
    if (!(child instanceof HTMLElement)) return null
    const kind = child.getAttribute("data-idml-protected")
    if (kind === "slot") {
      const index = child.getAttribute("data-idml-slot")
      const styleId = child.getAttribute("data-idml-character-style")
      if (!index || !styleId) return null
      const locked = child.getAttribute("contenteditable") === "false"
      html += `<span data-idml-slot="${escapeAttr(index)}" data-idml-character-style="${escapeAttr(styleId)}" data-idml-protected="slot"${locked ? " contenteditable=\"false\"" : ""}>${serializeSlotInner(child)}</span>`
      continue
    }
    if (kind !== "token") return null
    const token = child.getAttribute("data-idml-token")
    const tokenKind = child.getAttribute("data-idml-token-kind")
    if (!token || !tokenKind) return null
    const attributes = `data-idml-token="${escapeAttr(token)}" data-idml-token-kind="${escapeAttr(tokenKind)}" data-idml-protected="token" contenteditable="false"`
    html += tokenKind === "br" ? `<br ${attributes}>` : `<span ${attributes}></span>`
  }
  return `${html}</p>`
}

/** Write slot texts back into a canonical protected paragraph. */
export function rewriteIdmlSlotTexts(
  html: string,
  texts: ReadonlyMap<number, string>,
): string | null {
  if (typeof document === "undefined") return null
  const template = document.createElement("template")
  template.innerHTML = sanitizeIdmlEditorHtml(html)
  const paragraph = template.content.querySelector("p")
  if (!(paragraph instanceof HTMLElement)) return null
  for (const [index, text] of texts) {
    const slot = paragraph.querySelector<HTMLElement>(`span[data-idml-slot="${index}"]`)
    if (!slot) return null
    writeSlotText(slot, text)
  }
  return serializeProtectedParagraph(paragraph)
}
