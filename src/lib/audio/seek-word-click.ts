// Alt/Option+click on a word seeks playback to that word's start. Shared by
// the editor karaoke plugin and the read-only cell surface so the gesture
// works whether or not the cell is being edited (AQU-1211).

import type { WordTiming } from "@/lib/codex-editor/types"
import { findTimingAtPlainOffset } from "./timings"

/** Option on Apple keyboards, Alt elsewhere — both set MouseEvent.altKey. */
export function isWordSeekClick(
  event: Pick<MouseEvent, "altKey" | "metaKey" | "ctrlKey" | "shiftKey" | "button">,
): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false
  return event.button === undefined || event.button === 0
}

export function plainOffsetFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const doc = root.ownerDocument
  const withCaret = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let nodeOffset = 0
  if (typeof withCaret.caretRangeFromPoint === "function") {
    const range = withCaret.caretRangeFromPoint(clientX, clientY)
    if (!range) return null
    node = range.startContainer
    nodeOffset = range.startOffset
  } else if (typeof withCaret.caretPositionFromPoint === "function") {
    const pos = withCaret.caretPositionFromPoint(clientX, clientY)
    if (!pos) return null
    node = pos.offsetNode
    nodeOffset = pos.offset
  } else {
    return null
  }
  if (!node || !root.contains(node)) return null
  if (node.nodeType === Node.ELEMENT_NODE) {
    const child = node.childNodes[nodeOffset] ?? null
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let plain = 0
    let current: Node | null
    while ((current = walker.nextNode())) {
      if (child && (current === child || child.contains(current))) return plain
      plain += current.textContent?.length ?? 0
    }
    return plain
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let plain = 0
  let current: Node | null
  while ((current = walker.nextNode())) {
    const text = current.textContent ?? ""
    if (current === node) return plain + Math.min(nodeOffset, text.length)
    plain += text.length
  }
  return null
}

export function timingFromClick(
  timings: WordTiming[] | undefined,
  root: HTMLElement | null,
  event: MouseEvent,
): WordTiming | undefined {
  if (!isWordSeekClick(event) || !root) return undefined
  const plain = plainOffsetFromPoint(root, event.clientX, event.clientY)
  if (plain === null) return undefined
  return findTimingAtPlainOffset(timings, plain)
}
