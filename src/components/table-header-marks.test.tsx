import { describe, it, expect } from "vitest"
import { screen } from "@testing-library/react"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
import { CheckMarks, GutterMarks } from "./table-header-marks"

// Sam, 2026-09-28: the header names the table's narrow columns.
describe("the table header's column marks", () => {
  it("names the gutter's three columns, left to right, on hover", async () => {
    renderWithTooltips(<GutterMarks numbers="verse" />)
    const marks = screen.getAllByRole("img")
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual([
      "Select lines for batch actions. Drag up or down the column to select a range.",
      "Notices: open comments, a changed source, lost formatting, a voice that failed",
      "Verse number",
    ])
    await expectTooltip(marks[1], /^Notices:/)
  })

  // Sam, 2026-09-28: "Cell number" everywhere but a file of chapters.
  it("says Cell number where cells are counted, not verses", () => {
    renderWithTooltips(<GutterMarks numbers="cell" />)
    expect(screen.getByRole("img", { name: "Cell number" })).toBeInTheDocument()
  })

  it("has no number mark when line numbers are off", () => {
    renderWithTooltips(<GutterMarks numbers={null} />)
    expect(screen.getAllByRole("img")).toHaveLength(2)
  })

  it("keeps each mark to its column's width", () => {
    renderWithTooltips(<GutterMarks numbers="cell" />)
    const [select, notices, number] = screen.getAllByRole("img")
    expect(select.className).toContain("w-5")
    expect(notices.className).toContain("w-5")
    expect(number.className).toContain("flex-1")
  })

  it("tells the two check columns apart: text, then audio", async () => {
    renderWithTooltips(<CheckMarks audioColumn="on" />)
    const [text, audio] = screen.getAllByRole("img")
    await expectTooltip(text, "Text validation")
    await expectTooltip(audio, "Audio validation")
  })

  // AQU-1495: the audio mark stands over the rows' audio column, which a file
  // with no audio does not have. Left there, it pushed the Target heading
  // 30px past the rows' target boxes.
  it("has no audio mark when the rows have no audio column", () => {
    renderWithTooltips(<CheckMarks audioColumn="off" />)
    expect(screen.getAllByRole("img").map((m) => m.getAttribute("aria-label"))).toEqual(["Text validation"])
  })

  it("keeps the audio mark while the rows hold their placeholder", () => {
    renderWithTooltips(<CheckMarks audioColumn="checking" />)
    expect(screen.getByRole("img", { name: "Audio validation" })).toBeInTheDocument()
  })
})
