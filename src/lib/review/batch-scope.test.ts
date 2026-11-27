import { describe, expect, it } from "vitest"
import {
  WHOLE_BOOK,
  applyChapterScope,
  chapterLabelForMilestoneKey,
  initialChapterScope,
} from "./batch-scope"

const cells = [
  { id: "a", group: "GEN 1:1" },
  { id: "b", group: "GEN 1:2" },
  { id: "c", group: "GEN 2:1" },
  { id: "d", group: "heading" },
]

describe("chapter scope for a batch on the open book", () => {
  it("reads the editor's milestone key as the chapter label", () => {
    expect(chapterLabelForMilestoneKey("scripture:GEN:1")).toBe("GEN 1")
    expect(chapterLabelForMilestoneKey("scripture:1CO:12")).toBe("1CO 12")
    expect(chapterLabelForMilestoneKey("story:OBS:3")).toBe("OBS 3")
    expect(chapterLabelForMilestoneKey("time:120000")).toBeNull()
    expect(chapterLabelForMilestoneKey(null)).toBeNull()
  })

  it("opens on the chapter in view, else the first chapter", () => {
    const chapters = ["GEN 1", "GEN 2"]
    expect(initialChapterScope(chapters, "scripture:GEN:2")).toBe("GEN 2")
    expect(initialChapterScope(chapters, null)).toBe("GEN 1")
    expect(initialChapterScope([], "scripture:GEN:1")).toBe(WHOLE_BOOK)
  })

  it("keeps every cell for the whole book and one chapter otherwise", () => {
    expect(applyChapterScope(cells, WHOLE_BOOK).map((cell) => cell.id)).toEqual(["a", "b", "c", "d"])
    expect(applyChapterScope(cells, undefined).map((cell) => cell.id)).toEqual(["a", "b", "c", "d"])
    expect(applyChapterScope(cells, "GEN 1").map((cell) => cell.id)).toEqual(["a", "b"])
    expect(applyChapterScope(cells, "GEN 2").map((cell) => cell.id)).toEqual(["c"])
  })
})
