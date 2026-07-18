import { describe, expect, it } from "vitest"
import { normalizeMeasuredSelectionRects } from "./footnote-decoration-plugin"

describe("normalizeMeasuredSelectionRects", () => {
  const host = { left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200 }
  const clip = { left: 20, top: 30, right: 260, bottom: 180, width: 240, height: 150 }

  it("clips selection rects to the editor and converts them to host-local coordinates", () => {
    const rects = normalizeMeasuredSelectionRects(
      [
        { left: 15, top: 25, right: 120, bottom: 45, width: 105, height: 20 },
        { left: 40, top: 60, right: 280, bottom: 80, width: 240, height: 20 },
      ],
      host,
      clip,
    )

    expect(rects).toEqual([
      { left: 10, top: 10, width: 100, height: 15 },
      { left: 30, top: 40, width: 220, height: 20 },
    ])
  })

  it("drops empty and duplicate rects", () => {
    const rects = normalizeMeasuredSelectionRects(
      [
        { left: 40, top: 60, right: 40, bottom: 80, width: 0, height: 20 },
        { left: 40, top: 60, right: 90, bottom: 80, width: 50, height: 20 },
        { left: 40.2, top: 60.1, right: 90.1, bottom: 80.3, width: 49.9, height: 20.2 },
      ],
      host,
      clip,
    )

    expect(rects).toEqual([
      { left: 30, top: 40, width: 50, height: 20 },
    ])
  })
})
