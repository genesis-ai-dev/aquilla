import { describe, expect, it } from "vitest"
import {
  firstActuallyVisibleIndex,
  resolveActiveChapterLabel,
  rowMatchesChapterHeading,
  sectionLabelAtViewportStart,
  shouldAcceptChapterVisibleIndex,
} from "./chapter-navigation"

describe("sectionLabelAtViewportStart", () => {
  it("keeps the previous chapter active while its final verse starts the viewport", () => {
    const sections = new Map([
      ["chapter-1-verse-25", "1PE 1"],
      ["chapter-2-heading", "1PE 2"],
      ["chapter-2-verse-1", "1PE 2"],
    ])

    expect(sectionLabelAtViewportStart(
      [...sections.keys()],
      0,
      (cellId) => sections.get(cellId) ?? "",
    )).toBe("1PE 1")
  })

  it("ignores a retained previous row hidden above the list viewport", () => {
    expect(firstActuallyVisibleIndex([
      { index: 24, top: 66, bottom: 154 },
      { index: 25, top: 154, bottom: 242 },
      { index: 26, top: 242, bottom: 330 },
    ], 166, 24)).toBe(25)
  })

  it("keeps the previous row while any of it remains in the visible area", () => {
    expect(firstActuallyVisibleIndex([
      { index: 24, top: 171, bottom: 259 },
      { index: 25, top: 259, bottom: 347 },
    ], 166, 25)).toBe(24)
  })

  it("recognizes a next-chapter heading even when its canonical ref is still previous", () => {
    expect(rowMatchesChapterHeading(
      ["1 Peter 2", "1Peter 2"],
      "1 Peter 2",
    )).toBe(true)
    expect(rowMatchesChapterHeading(
      ["The word of the Lord remains forever"],
      "1 Peter 2",
    )).toBe(false)
  })
})

describe("shouldAcceptChapterVisibleIndex", () => {
  it("ignores intermediate rows while a chapter jump is in flight", () => {
    const pending = { index: 40, endIndex: 60 }
    expect(shouldAcceptChapterVisibleIndex(pending, 12)).toBe(false)
    expect(shouldAcceptChapterVisibleIndex(pending, 39)).toBe(false)
    expect(shouldAcceptChapterVisibleIndex(pending, 40)).toBe(true)
    expect(shouldAcceptChapterVisibleIndex(pending, 59)).toBe(true)
    expect(shouldAcceptChapterVisibleIndex(pending, 60)).toBe(false)
  })

  it("accepts every update when no jump is pending", () => {
    expect(shouldAcceptChapterVisibleIndex(null, 0)).toBe(true)
    expect(shouldAcceptChapterVisibleIndex(null, 99)).toBe(true)
  })
})

describe("resolveActiveChapterLabel", () => {
  const labels = ["MAT 1", "MAT 2", "MAT 3"]

  it("keeps the pinned destination chapter while the viewport lags", () => {
    expect(resolveActiveChapterLabel(labels, "MAT 1", "MAT 3")).toBe("MAT 3")
  })

  it("falls back to the viewport section, then the first chapter", () => {
    expect(resolveActiveChapterLabel(labels, "MAT 2", null)).toBe("MAT 2")
    expect(resolveActiveChapterLabel(labels, "UNKNOWN", null)).toBe("MAT 1")
  })
})
