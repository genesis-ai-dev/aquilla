/**
 * Hover and drag for the edges of bold and italic runs. The host paints the
 * slots and applies the word move; this only tracks the pointer.
 */

import { useEffect, useLayoutEffect, useRef } from "react"
import {
  segmentEdgeRegion,
  type SegmentEdge,
  type SegmentPiece,
} from "@/lib/idml/segment-edge"
import {
  boundaryCaret,
  boundaryOffsetAtPoint,
  clearSegmentDragGuide,
  clearSegmentDragRegion,
  paintSegmentDragRegion,
  paintSegmentEdge,
  placeSegmentDragGuide,
  segmentEdgeBar,
  segmentEdgeHit,
  type SegmentEdgeHit,
} from "@/lib/idml/segment-edge-hit"

export interface StyleSegmentEdgeDrag {
  enabled: boolean
  getContainer: () => HTMLElement | null
  getPieces: () => SegmentPiece[] | null
  onEdge: (slotIndex: number, edge: SegmentEdge, boundary: number) => void
  onGestureEnd: () => void
}

export function useStyleSegmentEdgeDrag(options: StyleSegmentEdgeDrag): void {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const { enabled } = options
  const repaintRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    repaintRef.current?.()
  })

  useEffect(() => {
    if (!enabled) return
    const container = optionsRef.current.getContainer()
    if (!container) return
    container.setAttribute("data-segment-edge-mode", "")

    let drag: SegmentEdgeHit | null = null
    let lastOffset: number | null = null
    let bodyCursor = ""

    const hover = (event: PointerEvent) => {
      if (drag) return
      const pieces = optionsRef.current.getPieces()
      const hit = segmentEdgeHit(container, event.clientX, event.clientY)
      const allowed = Boolean(
        hit
        && pieces
        && segmentEdgeRegion(pieces, hit.slotIndex, hit.edge),
      )
      paintSegmentEdge(
        container,
        allowed && hit ? hit.slotIndex : null,
        allowed && hit ? hit.physical : null,
      )
    }

    const showCut = (offset: number) => {
      const pieces = optionsRef.current.getPieces()
      if (!pieces || !drag) return
      lastOffset = offset
      paintSegmentDragRegion(container, pieces, drag.slotIndex, drag.edge)
      const caret = boundaryCaret(container, pieces, drag.slotIndex, drag.edge, offset)
        ?? segmentEdgeBar(container, drag.slotIndex, drag.edge)
      if (caret) placeSegmentDragGuide(caret)
      paintSegmentEdge(container, drag.slotIndex, drag.physical)
    }

    // A draft refresh replaces the slot markup and drops the cut chrome.
    // Measure again after that paint so the bar stays on the word boundary.
    repaintRef.current = () => {
      if (!drag || lastOffset === null) return
      showCut(lastOffset)
    }

    const move = (event: PointerEvent) => {
      if (!drag) return
      const pieces = optionsRef.current.getPieces()
      if (!pieces) return
      const offset = boundaryOffsetAtPoint(
        container,
        pieces,
        drag.slotIndex,
        drag.edge,
        event.clientX,
        event.clientY,
      )
      if (offset === null) return
      optionsRef.current.onEdge(drag.slotIndex, drag.edge, offset)
      showCut(offset)
    }

    const end = () => {
      if (!drag) return
      drag = null
      lastOffset = null
      document.body.style.cursor = bodyCursor
      paintSegmentEdge(container, null, null)
      clearSegmentDragRegion(container)
      clearSegmentDragGuide()
      container.removeAttribute("data-segment-dragging")
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      optionsRef.current.onGestureEnd()
    }

    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      const pieces = optionsRef.current.getPieces()
      const hit = segmentEdgeHit(container, event.clientX, event.clientY)
      if (!hit || !pieces || !segmentEdgeRegion(pieces, hit.slotIndex, hit.edge)) return
      event.preventDefault()
      event.stopPropagation()
      drag = hit
      bodyCursor = document.body.style.cursor
      document.body.style.cursor = "ew-resize"
      container.setAttribute("data-segment-dragging", "")
      paintSegmentEdge(container, hit.slotIndex, hit.physical)
      if (pieces) paintSegmentDragRegion(container, pieces, hit.slotIndex, hit.edge)
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", end)
      window.addEventListener("pointercancel", end)
    }

    const leave = () => {
      if (!drag) paintSegmentEdge(container, null, null)
    }

    container.addEventListener("pointerdown", down, true)
    container.addEventListener("pointermove", hover)
    container.addEventListener("pointerleave", leave)

    return () => {
      container.removeEventListener("pointerdown", down, true)
      container.removeEventListener("pointermove", hover)
      container.removeEventListener("pointerleave", leave)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      if (drag) {
        drag = null
        lastOffset = null
        document.body.style.cursor = bodyCursor
        optionsRef.current.onGestureEnd()
      }
      paintSegmentEdge(container, null, null)
      clearSegmentDragRegion(container)
      clearSegmentDragGuide()
      container.removeAttribute("data-segment-dragging")
      container.removeAttribute("data-segment-edge-mode")
      repaintRef.current = null
    }
  }, [enabled])
}
