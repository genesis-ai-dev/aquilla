import { describe, expect, it } from "vitest"
import {
  cellIdsForChapterPage,
  chapterPageProgress,
  filterToChapterPage,
  firstActuallyVisibleIndex,
  milestonePageForCell,
  resolveActiveChapterLabel,
  resolveChapterPageKey,
  rowMatchesChapterHeading,
  sectionLabelAtViewportStart,
  validStoredChapterPage,
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

describe("resolveChapterPageKey (AQU-1087)", () => {
  const keys = ["scripture:GEN:1", "scripture:GEN:2", "scripture:GEN:3"]

  it("keeps full-book viewport tracking when paging is off", () => {
    expect(resolveChapterPageKey({
      pagingEnabled: false,
      navigationKeys: keys,
      selectedKey: null,
      viewportKey: "scripture:GEN:2",
    })).toBe("scripture:GEN:2")
  })

  it("keeps an explicit picker selection while paging, ignoring the viewport", () => {
    expect(resolveChapterPageKey({
      pagingEnabled: true,
      navigationKeys: keys,
      selectedKey: "scripture:GEN:3",
      viewportKey: "scripture:GEN:1",
    })).toBe("scripture:GEN:3")
  })

  it("uses the full-file viewport chapter when paging turns on with no selection", () => {
    expect(resolveChapterPageKey({
      pagingEnabled: true,
      navigationKeys: keys,
      selectedKey: null,
      viewportKey: "scripture:GEN:2",
    })).toBe("scripture:GEN:2")
  })

  it("falls back to the first chapter when neither selection nor viewport matches", () => {
    expect(resolveChapterPageKey({
      pagingEnabled: true,
      navigationKeys: keys,
      selectedKey: "scripture:EXO:1",
      viewportKey: "",
    })).toBe("scripture:GEN:1")
  })
})

describe("validStoredChapterPage (AQU-1087)", () => {
  const navigation = [
    { key: "scripture:GEN:1" },
    {
      key: "scripture:GEN:2",
      subsections: [
        { key: "scripture:GEN:2:range:g3" },
        { key: "scripture:GEN:2:range:g5" },
      ],
    },
  ]

  it("returns the stored chapter when it still exists in this file", () => {
    expect(validStoredChapterPage(navigation, { key: "scripture:GEN:2" })).toEqual({
      key: "scripture:GEN:2",
    })
  })

  it("keeps a subsection only while that range still exists", () => {
    expect(validStoredChapterPage(navigation, {
      key: "scripture:GEN:2",
      subsectionKey: "scripture:GEN:2:range:g5",
    })).toEqual({
      key: "scripture:GEN:2",
      subsectionKey: "scripture:GEN:2:range:g5",
    })
    expect(validStoredChapterPage(navigation, {
      key: "scripture:GEN:2",
      subsectionKey: "scripture:GEN:2:range:gone",
    })).toEqual({ key: "scripture:GEN:2" })
  })

  it("returns null when the stored chapter is from another book or a reimport", () => {
    expect(validStoredChapterPage(navigation, { key: "scripture:EXO:1" })).toBeNull()
    expect(validStoredChapterPage(navigation, null)).toBeNull()
  })
})

describe("cellIdsForChapterPage (AQU-1087)", () => {
  const navigation = [
    { key: "scripture:GEN:1", cellIds: ["g1", "g2"] },
    {
      key: "scripture:GEN:2",
      cellIds: ["g3", "g4", "g5"],
      subsections: [
        { key: "scripture:GEN:2:range:g3", cellIds: ["g3", "g4"] },
        { key: "scripture:GEN:2:range:g5", cellIds: ["g5"] },
      ],
    },
  ]
  const allCellIds = ["g1", "g2", "g3", "g4", "g5"]

  it("returns the full file when paging is off", () => {
    expect(cellIdsForChapterPage({
      pagingEnabled: false,
      allCellIds,
      navigation,
      pageKey: "scripture:GEN:1",
    })).toEqual(allCellIds)
  })

  it("returns only the selected chapter's cells when paging is on", () => {
    expect(cellIdsForChapterPage({
      pagingEnabled: true,
      allCellIds,
      navigation,
      pageKey: "scripture:GEN:2",
    })).toEqual(["g3", "g4", "g5"])
  })

  it("narrows to a subsection when the navigator is on a cell range", () => {
    expect(cellIdsForChapterPage({
      pagingEnabled: true,
      allCellIds,
      navigation,
      pageKey: "scripture:GEN:2",
      subsectionKey: "scripture:GEN:2:range:g5",
    })).toEqual(["g5"])
  })
})

describe("milestonePageForCell (AQU-1087)", () => {
  const navigation = [
    { key: "scripture:GEN:1", cellIds: ["g1"] },
    {
      key: "scripture:GEN:2",
      cellIds: ["g2", "g3"],
      subsections: [
        { key: "r1", cellIds: ["g2"] },
        { key: "r2", cellIds: ["g3"] },
      ],
    },
  ]

  it("returns the chapter and subsection that contain the cell", () => {
    expect(milestonePageForCell(navigation, "g3")).toEqual({
      key: "scripture:GEN:2",
      subsectionKey: "r2",
    })
  })

  it("returns null when the cell is not in the file", () => {
    expect(milestonePageForCell(navigation, "missing")).toBeNull()
  })
})

describe("filterToChapterPage (AQU-1087)", () => {
  const cells = [
    { id: "g1", status: "validated" },
    { id: "g2", status: "unvalidated" },
    { id: "g3", status: "empty" },
  ]

  it("returns the full list when paging is off", () => {
    expect(filterToChapterPage(cells, null).map((cell) => cell.id)).toEqual(["g1", "g2", "g3"])
  })

  it("keeps document order of the matching page ids", () => {
    expect(filterToChapterPage(cells, ["g3", "g1"]).map((cell) => cell.id)).toEqual(["g1", "g3"])
  })

  it("returns nothing while the page has not been reported yet", () => {
    expect(filterToChapterPage(cells, [])).toEqual([])
  })
})

describe("chapterPageProgress (AQU-1087)", () => {
  it("matches useHealth: non-empty counts as translated", () => {
    expect(chapterPageProgress([
      { status: "validated" },
      { status: "unvalidated" },
      { status: "empty" },
    ])).toEqual({ translated: 2, validated: 1, total: 3 })
  })
})
