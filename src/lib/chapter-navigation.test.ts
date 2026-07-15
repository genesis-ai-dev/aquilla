import { describe, expect, it } from "vitest"
import { sectionLabelAtViewportStart } from "./chapter-navigation"

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

  it("switches chapters once the next chapter reaches the viewport start", () => {
    const cellIds = ["chapter-1-verse-25", "chapter-2-heading", "chapter-2-verse-1"]
    expect(sectionLabelAtViewportStart(
      cellIds,
      1,
      (cellId) => cellId.startsWith("chapter-2") ? "1PE 2" : "1PE 1",
    )).toBe("1PE 2")
  })
})
