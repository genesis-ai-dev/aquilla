/**
 * Pointer geometry for a style-segment edge. The model of which words move
 * lives in `segment-edge.ts`; this only decides which edge the pointer is on
 * and which word boundary it is nearest.
 */

import {
  segmentEdgeRegion,
  wordBoundaryOffsets,
  type SegmentEdge,
  type SegmentPiece,
} from "@/lib/idml/segment-edge"
import { syncIdmlPlainGroups, syncIdmlStyleSegmentEmpty } from "@/lib/richtext/idml-style-display"

const EDGE_PX = 8

export interface SegmentEdgeHit {
  slotIndex: number
  edge: SegmentEdge
  physical: "left" | "right"
}

export interface BoundaryMark {
  offset: number
  x: number
  top: number
  bottom: number
}

function edgeDistance(
  rect: DOMRect,
  side: "left" | "right",
  x: number,
  y: number,
): number | null {
  if (y < rect.top - 3 || y > rect.bottom + 3) return null
  const edgeX = side === "left" ? rect.left : rect.right
  const distance = Math.abs(x - edgeX)
  if (distance > EDGE_PX) return null
  return distance
}

/** The emphasis box whose left or right side the pointer is within a few pixels of. */
export function segmentEdgeHit(
  container: HTMLElement,
  x: number,
  y: number,
): SegmentEdgeHit | null {
  const rtl = getComputedStyle(container).direction === "rtl"
  const slots = container.querySelectorAll<HTMLElement>(
    "[data-idml-protected='slot'].idml-style-bold, [data-idml-protected='slot'].idml-style-italic",
  )
  let best: (SegmentEdgeHit & { distance: number }) | null = null
  for (const slot of slots) {
    const slotIndex = Number(slot.getAttribute("data-idml-slot"))
    if (!Number.isInteger(slotIndex)) continue
    const rects = [...slot.getClientRects()]
    const first = rects[0]
    const last = rects[rects.length - 1]
    if (!first || !last) continue
    const candidates: Array<{ physical: "left" | "right"; rect: DOMRect; edge: SegmentEdge }> = [
      { physical: rtl ? "right" : "left", rect: first, edge: "start" },
      { physical: rtl ? "left" : "right", rect: last, edge: "end" },
    ]
    for (const candidate of candidates) {
      const distance = edgeDistance(candidate.rect, candidate.physical, x, y)
      if (distance === null) continue
      if (!best || distance < best.distance) {
        best = {
          slotIndex,
          edge: candidate.edge,
          physical: candidate.physical,
          distance,
        }
      }
    }
  }
  if (!best) return null
  return { slotIndex: best.slotIndex, edge: best.edge, physical: best.physical }
}

/** Same line wins on horizontal distance. A different line has to be close. */
export function nearestMark(
  marks: readonly BoundaryMark[],
  x: number,
  y: number,
): BoundaryMark | null {
  let best: BoundaryMark | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const mark of marks) {
    const dy = y < mark.top ? mark.top - y : y > mark.bottom ? y - mark.bottom : 0
    const dx = Math.abs(x - mark.x)
    const distance = dy === 0 ? dx : dx + dy * dy
    if (distance < bestDistance) {
      best = mark
      bestDistance = distance
    }
  }
  return best
}

function slotDomText(slot: HTMLElement): string {
  let text = ""
  const walker = document.createTreeWalker(slot, NodeFilter.SHOW_ALL)
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent ?? "").replace(/\u200b/g, "")
    } else if (node instanceof HTMLElement && node.tagName === "BR") {
      text += "\n"
    }
    node = walker.nextNode()
  }
  return text
}

function locateVisible(
  slots: readonly HTMLElement[],
  offset: number,
): { node: Text; offset: number } | null {
  let seen = 0
  let last: { node: Text; offset: number } | null = null
  for (const slot of slots) {
    const walker = document.createTreeWalker(slot, NodeFilter.SHOW_TEXT)
    let current = walker.nextNode()
    while (current) {
      const raw = current.textContent ?? ""
      for (let index = 0; index <= raw.length; index += 1) {
        if (seen === offset) return { node: current as Text, offset: index }
        if (index === raw.length) break
        if (raw[index] === "\u200b") continue
        seen += 1
        last = { node: current as Text, offset: index + 1 }
      }
      current = walker.nextNode()
    }
  }
  if (seen === offset) return last
  return null
}

function boxOf(rect: DOMRect | undefined): { x: number; top: number; bottom: number } | null {
  if (!rect) return null
  if (rect.height <= 0 && rect.width <= 0 && rect.top === 0 && rect.left === 0) return null
  return { x: rect.left, top: rect.top, bottom: rect.bottom || rect.top }
}

function caretBox(
  slots: readonly HTMLElement[],
  offset: number,
  rtl: boolean,
): { x: number; top: number; bottom: number } | null {
  const located = locateVisible(slots, offset)
  if (!located) return null
  const range = document.createRange()
  range.setStart(located.node, located.offset)
  range.setEnd(located.node, located.offset)
  const caret = boxOf(range.getClientRects()[0] ?? range.getBoundingClientRect())
  if (caret && caret.bottom > caret.top) return caret
  // A caret at the end of a line often has no box. The previous character's
  // far side is the same boundary.
  if (offset === 0) return caret
  const previous = locateVisible(slots, offset - 1)
  if (!previous) return caret
  range.setStart(previous.node, previous.offset)
  range.setEnd(located.node, located.offset)
  const glyph = range.getClientRects()[0] ?? range.getBoundingClientRect()
  const measured = boxOf(glyph)
  if (!measured) return caret
  return { ...measured, x: rtl ? glyph.left : glyph.right }
}

/**
 * The word boundary nearest the pointer, as a character offset into the
 * edge's movable runs. Null when the painted text does not match the model.
 */
export function boundaryOffsetAtPoint(
  container: HTMLElement,
  pieces: readonly SegmentPiece[],
  slotIndex: number,
  edge: SegmentEdge,
  x: number,
  y: number,
): number | null {
  const region = segmentEdgeRegion(pieces, slotIndex, edge)
  if (!region) return null
  const elements: HTMLElement[] = []
  for (const slot of region.slots) {
    const element = container.querySelector<HTMLElement>(
      `[data-idml-protected="slot"][data-idml-slot="${slot.index}"]`,
    )
    if (!element) return null
    elements.push(element)
  }
  const modelText = region.slots.map((slot) => slot.text).join("")
  const domText = elements.map(slotDomText).join("")
  if (domText !== modelText) return null
  const rtl = getComputedStyle(container).direction === "rtl"
  const marks: BoundaryMark[] = []
  for (const offset of wordBoundaryOffsets(modelText, edge)) {
    const box = caretBox(elements, offset, rtl)
    if (!box) continue
    marks.push({ offset, ...box })
  }
  return nearestMark(marks, x, y)?.offset ?? null
}

/** Where a boundary sits after the words have moved, so the drag can mark the cut. */
export function boundaryCaret(
  container: HTMLElement,
  pieces: readonly SegmentPiece[],
  slotIndex: number,
  edge: SegmentEdge,
  offset: number,
): { x: number; top: number; bottom: number } | null {
  const region = segmentEdgeRegion(pieces, slotIndex, edge)
  if (!region) return null
  const elements: HTMLElement[] = []
  for (const slot of region.slots) {
    const element = container.querySelector<HTMLElement>(
      `[data-idml-protected="slot"][data-idml-slot="${slot.index}"]`,
    )
    if (!element) return null
    elements.push(element)
  }
  const modelText = region.slots.map((slot) => slot.text).join("")
  if (elements.map(slotDomText).join("") !== modelText) return null
  const rtl = getComputedStyle(container).direction === "rtl"
  return caretBox(elements, offset, rtl)
}

/**
 * Write slot text into the live cell immediately. A React refresh of the same
 * words can follow; the box has to change before that, or the drag shows nothing.
 */
export function paintSegmentSlotTexts(
  container: HTMLElement,
  texts: ReadonlyMap<number, string>,
): void {
  let painted = false
  for (const [index, text] of texts) {
    const slot = container.querySelector<HTMLElement>(
      `[data-idml-protected="slot"][data-idml-slot="${index}"]`,
    )
    if (!slot) continue
    painted = true
    const parts = text.split("\n")
    slot.replaceChildren()
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      if (partIndex > 0) slot.append(document.createElement("br"))
      const part = parts[partIndex] ?? ""
      if (part.length > 0) slot.append(document.createTextNode(part))
    }
    syncIdmlStyleSegmentEmpty(slot, text, text.includes("\n"))
  }
  if (painted) syncIdmlPlainGroups(container)
}

/** Mark the runs the edge can travel through, and which of them is the box. */
export function paintSegmentDragRegion(
  container: HTMLElement,
  pieces: readonly SegmentPiece[],
  slotIndex: number,
  edge: SegmentEdge,
): void {
  clearSegmentDragRegion(container)
  const region = segmentEdgeRegion(pieces, slotIndex, edge)
  if (!region) return
  region.slots.forEach((slot, index) => {
    const element = container.querySelector<HTMLElement>(
      `[data-idml-protected="slot"][data-idml-slot="${slot.index}"]`,
    )
    if (!element) return
    element.setAttribute(
      "data-segment-drag-region",
      index === region.emphasisAt ? "emphasis" : "plain",
    )
  })
}

export function clearSegmentDragRegion(container: HTMLElement): void {
  for (const element of container.querySelectorAll<HTMLElement>("[data-segment-drag-region]")) {
    element.removeAttribute("data-segment-drag-region")
  }
}

const DRAG_GUIDE_ATTR = "data-segment-drag-guide"

/**
 * The box edge itself, used when a caret inside the words has no layout box.
 * Keeps the cut visible on the side being dragged.
 */
export function segmentEdgeBar(
  container: HTMLElement,
  slotIndex: number,
  edge: SegmentEdge,
): { x: number; top: number; bottom: number } | null {
  const slot = container.querySelector<HTMLElement>(
    `[data-idml-protected="slot"][data-idml-slot="${slotIndex}"]`,
  )
  if (!slot) return null
  const rects = [...slot.getClientRects()]
  const rect = edge === "end" ? rects[rects.length - 1] : rects[0]
  if (!rect || rect.height <= 0) return null
  const rtl = getComputedStyle(container).direction === "rtl"
  const atStart = edge === "start"
  const x = atStart === rtl ? rect.right : rect.left
  return { x: atStart ? x : (rtl ? rect.left : rect.right), top: rect.top, bottom: rect.bottom }
}

/** A bar at the word the edge is on. Stays up while the pointer is past the box. */
export function placeSegmentDragGuide(
  box: { x: number; top: number; bottom: number } | null,
): void {
  const existing = document.querySelector<HTMLElement>(`[${DRAG_GUIDE_ATTR}]`)
  if (!box) {
    existing?.remove()
    return
  }
  const guide = existing ?? document.createElement("div")
  if (!existing) {
    guide.setAttribute(DRAG_GUIDE_ATTR, "")
    guide.className = "aq-segment-drag-guide"
    document.body.append(guide)
  }
  const top = box.top - 3
  const height = Math.max(box.bottom - box.top, 14) + 6
  guide.style.left = `${box.x}px`
  guide.style.top = `${top}px`
  guide.style.height = `${height}px`
}

export function clearSegmentDragGuide(): void {
  document.querySelector(`[${DRAG_GUIDE_ATTR}]`)?.remove()
}

export function paintSegmentEdge(
  container: HTMLElement,
  slotIndex: number | null,
  physical: "left" | "right" | null,
): void {
  for (const slot of container.querySelectorAll<HTMLElement>("[data-segment-edge]")) {
    slot.removeAttribute("data-segment-edge")
    slot.style.cursor = ""
  }
  if (slotIndex === null || !physical) return
  const slot = container.querySelector<HTMLElement>(`[data-idml-slot="${slotIndex}"]`)
  if (!slot) return
  slot.setAttribute("data-segment-edge", physical)
  slot.style.cursor = "ew-resize"
}
