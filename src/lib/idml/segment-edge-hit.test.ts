import { describe, expect, it } from "vitest"
import type { SegmentPiece } from "./segment-edge"
import {
  clearSegmentDragGuide,
  clearSegmentDragRegion,
  nearestMark,
  paintSegmentDragRegion,
  paintSegmentSlotTexts,
  placeSegmentDragGuide,
  segmentEdgeHit,
} from "./segment-edge-hit"

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height)
}

function rectList(rects: DOMRect[]): DOMRectList {
  return {
    ...rects,
    length: rects.length,
    item: (index: number) => rects[index] ?? null,
    [Symbol.iterator]: function* iterator() {
      yield* rects
    },
  } as DOMRectList
}

describe("style segment edge hit", () => {
  it("grabs the side of a bold box and prefers the boundary on the pointer's line", () => {
    const container = document.createElement("div")
    const slot = document.createElement("span")
    slot.setAttribute("data-idml-protected", "slot")
    slot.setAttribute("data-idml-slot", "1")
    slot.className = "idml-style-bold"
    slot.getClientRects = () => rectList([rect(100, 10, 40, 16)])
    container.append(slot)
    document.body.append(container)

    expect(segmentEdgeHit(container, 102, 18)).toEqual({ slotIndex: 1, edge: "start", physical: "left" })
    expect(segmentEdgeHit(container, 138, 18)).toEqual({ slotIndex: 1, edge: "end", physical: "right" })
    expect(segmentEdgeHit(container, 120, 18)).toBeNull()

    container.style.direction = "rtl"
    expect(segmentEdgeHit(container, 138, 18)).toEqual({ slotIndex: 1, edge: "start", physical: "right" })
    expect(segmentEdgeHit(container, 102, 18)).toEqual({ slotIndex: 1, edge: "end", physical: "left" })

    const sameLine = nearestMark(
      [
        { offset: 0, x: 0, top: 0, bottom: 10 },
        { offset: 6, x: 50, top: 0, bottom: 10 },
      ],
      40,
      5,
    )
    expect(sameLine?.offset).toBe(6)

    const nextLine = nearestMark(
      [
        { offset: 0, x: 0, top: 0, bottom: 10 },
        { offset: 11, x: 100, top: 20, bottom: 30 },
      ],
      0,
      25,
    )
    expect(nextLine?.offset).toBe(11)
    container.remove()
  })

  it("paints words into and out of the box while the drag is still down", () => {
    const host = document.createElement("div")
    host.innerHTML =
      `<p>`
      + `<span data-idml-protected="slot" data-idml-slot="0" class="idml-style-bold">fox jumps</span>`
      + `<span data-idml-protected="slot" data-idml-slot="1"> high</span>`
      + `</p>`
    document.body.append(host)
    paintSegmentSlotTexts(host, new Map([[0, "fox"], [1, " jumps high"]]))
    expect(host.querySelector("[data-idml-slot='0']")?.textContent).toBe("fox")
    expect(host.querySelector("[data-idml-slot='1']")?.textContent).toBe(" jumps high")

    const pieces: SegmentPiece[] = [
      { kind: "slot", index: 0, text: "fox", emphasis: true, editable: true, broken: false },
      { kind: "slot", index: 1, text: " jumps high", emphasis: false, editable: true, broken: false },
    ]
    paintSegmentDragRegion(host, pieces, 0, "end")
    expect(host.querySelector("[data-idml-slot='0']")?.getAttribute("data-segment-drag-region")).toBe("emphasis")
    expect(host.querySelector("[data-idml-slot='1']")?.getAttribute("data-segment-drag-region")).toBe("plain")
    clearSegmentDragRegion(host)
    expect(host.querySelector("[data-segment-drag-region]")).toBeNull()

    placeSegmentDragGuide({ x: 40, top: 10, bottom: 26 })
    const guide = document.querySelector("[data-segment-drag-guide]")
    expect(guide).not.toBeNull()
    expect((guide as HTMLElement).style.left).toBe("40px")
    clearSegmentDragGuide()
    expect(document.querySelector("[data-segment-drag-guide]")).toBeNull()
    host.remove()
  })
})
