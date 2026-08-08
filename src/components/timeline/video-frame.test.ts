import { describe, it, expect } from "vitest"
import { fitPictureRect, intrinsicAspect, DEFAULT_VIDEO_ASPECT } from "./video-frame"

describe("fitPictureRect", () => {
  it("letterboxes a tall field — bars above and below", () => {
    // The common case: a narrow, tall pane beside the text table.
    const rect = fitPictureRect(320, 600, 16 / 9)
    expect(rect).not.toBeNull()
    expect(rect!.width).toBeCloseTo(320)
    expect(rect!.height).toBeCloseTo(180)
    expect(rect!.height).toBeLessThan(600)
  })

  it("pillarboxes a wide field — bars left and right", () => {
    const rect = fitPictureRect(1200, 300, 16 / 9)
    expect(rect!.height).toBeCloseTo(300)
    expect(rect!.width).toBeCloseTo(533.33, 1)
    expect(rect!.width).toBeLessThan(1200)
  })

  it("fills exactly when the field already matches the ratio", () => {
    const rect = fitPictureRect(1600, 900, 16 / 9)
    expect(rect!.width).toBeCloseTo(1600)
    expect(rect!.height).toBeCloseTo(900)
  })

  it("honours a non-16:9 video", () => {
    // 4:3 in a 16:9-ish field pillarboxes.
    const rect = fitPictureRect(400, 300, 4 / 3)
    expect(rect!.width).toBeCloseTo(400)
    expect(rect!.height).toBeCloseTo(300)
    const tall = fitPictureRect(400, 600, 4 / 3)
    expect(tall!.width).toBeCloseTo(400)
    expect(tall!.height).toBeCloseTo(300)
  })

  it("never returns a box the field cannot hold", () => {
    for (const [w, h, a] of [[320, 600, 16 / 9], [1200, 300, 16 / 9], [500, 500, 2.35]] as const) {
      const rect = fitPictureRect(w, h, a)!
      expect(rect.width).toBeLessThanOrEqual(w + 0.001)
      expect(rect.height).toBeLessThanOrEqual(h + 0.001)
      expect(rect.width / rect.height).toBeCloseTo(a, 5)
    }
  })

  it("returns null for anything that cannot describe a real box", () => {
    // happy-dom has no layout engine, so every measurement there is 0 — this is
    // the branch that keeps the component rendering in tests instead of
    // collapsing to a 0x0 or NaN-sized picture.
    expect(fitPictureRect(0, 600, 16 / 9)).toBeNull()
    expect(fitPictureRect(320, 0, 16 / 9)).toBeNull()
    expect(fitPictureRect(320, 600, 0)).toBeNull()
    expect(fitPictureRect(-320, 600, 16 / 9)).toBeNull()
    expect(fitPictureRect(Number.NaN, 600, 16 / 9)).toBeNull()
    expect(fitPictureRect(320, Number.POSITIVE_INFINITY, 16 / 9)).toBeNull()
  })
})

describe("intrinsicAspect", () => {
  it("reads a loaded video's own ratio", () => {
    expect(intrinsicAspect(1920, 1080)).toBeCloseTo(16 / 9)
    expect(intrinsicAspect(640, 480)).toBeCloseTo(4 / 3)
  })

  it("is null until the element knows its dimensions", () => {
    // Before `loadedmetadata` both are 0; the caller falls back to 16:9.
    expect(intrinsicAspect(0, 0)).toBeNull()
    expect(intrinsicAspect(1920, 0)).toBeNull()
    expect(intrinsicAspect(Number.NaN, 1080)).toBeNull()
    expect(DEFAULT_VIDEO_ASPECT).toBeCloseTo(16 / 9)
  })
})
