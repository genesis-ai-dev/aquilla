import { describe, expect, it } from "vitest"
import {
  firstActuallyVisibleIndex,
  resolveActiveChapterLabel,
  rowMatchesChapterHeading,
  sectionLabelAtViewportStart,
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

describe("resolveActiveChapterLabel", () => {
  const chapters = ["GEN 1", "GEN 2"]

  it("keeps an explicit chapter selection authoritative over viewport tracking", () => {
    expect(resolveActiveChapterLabel(chapters, "GEN 1", "GEN 2")).toBe("GEN 2")
  })

  it("returns to viewport tracking when there is no explicit selection", () => {
    expect(resolveActiveChapterLabel(chapters, "GEN 2", null)).toBe("GEN 2")
  })

  it("ignores stale labels from another file", () => {
    expect(resolveActiveChapterLabel(chapters, "GEN 2", "EXO 1")).toBe("GEN 2")
  })
})
