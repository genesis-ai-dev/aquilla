import { describe, expect, it } from "vitest"
import { cellNeedsSourceReview, sourceReviewLanes } from "./source-review"

describe("source review flag", () => {
  const metadata = { aquillaImport: { reviewLanes: ["lane-fr", "lane-de"] } }

  it("reads the lanes a re-import asked to review", () => {
    expect(sourceReviewLanes(metadata)).toEqual(["lane-fr", "lane-de"])
    expect(sourceReviewLanes({})).toEqual([])
    expect(sourceReviewLanes(null)).toEqual([])
  })

  it("is true only for the open lane", () => {
    expect(cellNeedsSourceReview(metadata, "lane-fr")).toBe(true)
    expect(cellNeedsSourceReview(metadata, "lane-es")).toBe(false)
    expect(cellNeedsSourceReview(metadata, null)).toBe(false)
    expect(cellNeedsSourceReview(metadata, "")).toBe(false)
  })
})
