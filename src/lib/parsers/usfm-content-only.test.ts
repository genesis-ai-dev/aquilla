import { describe, it, expect } from "vitest"
import { usfmContentOnly } from "./usfm-content-only"

// Mirrors the ACT 1:4 cell from the agent import that surfaced AQU-1283:
// a footnote with a nested \fqa, a mid-verse \p carrying a USFM no-break
// space (~), \add and nested \+bk character markers, a crossref, poetry lines,
// and a dangling trailing \p that the lossless verse span keeps.
const ACT_1_4 =
  "Однажды, обедая вместе с ними\\f + \\fr 1:4 \\ft Или: «\\fqa Однажды, собрав их…\\ft »\\f*, Он велел " +
  "\\add им\\add* не покидать \\+bk Иерусалим\\+bk*\\x - \\xo 1:4 \\xt Лк 24:49\\x*.\r\n" +
  "\\p —~Это то, о чём говорил Отец.\r\n" +
  "\\q1 Строка один\r\n" +
  "\\q2 строка два\r\n" +
  "\\p"

describe("usfmContentOnly", () => {
  it("strips every marker from the ACT 1:4 shape — WHY: an agent import declares fidelity content-only, so no \\ may reach cell value", () => {
    const { text } = usfmContentOnly(ACT_1_4)
    expect(text).not.toContain("\\")
    expect(text).toBe(
      "Однажды, обедая вместе с ними, Он велел им не покидать Иерусалим.\n" +
        "— Это то, о чём говорил Отец.\n" +
        "Строка один\n" +
        "строка два",
    )
  })

  it("moves footnote/crossref bodies out of the text and into notes", () => {
    const { text, notes } = usfmContentOnly(ACT_1_4)
    expect(text).not.toContain("собрав их")
    expect(notes).toHaveLength(2)
    expect(notes[0].noteKind).toBe("footnote")
    expect(notes[0].caller).toBe("+")
    expect(notes[0].ref).toBe("1:4")
    expect(notes[0].text).toBe("Или: « Однажды, собрав их… »")
    expect(notes[0].text).not.toContain("\\")
    expect(notes[1].noteKind).toBe("xref")
    expect(notes[1].text).toBe("Лк 24:49")
  })

  it("turns the USFM no-break space (~) into a regular space", () => {
    expect(usfmContentOnly("\\p —~Это").text).toBe("— Это")
    expect(usfmContentOnly("plain~text").text).toBe("plain text")
  })

  it("drops a dangling trailing \\p / \\q1 without leaving a blank line", () => {
    expect(usfmContentOnly("Иоанн крестил водой.\n\\p").text).toBe("Иоанн крестил водой.")
    expect(usfmContentOnly("Иоанн крестил водой.\n\\q1\n").text).toBe("Иоанн крестил водой.")
  })

  it("collapses whitespace left behind by removed markup", () => {
    expect(usfmContentOnly("the  \\nd Lord\\nd*   spoke\t\\w today\\w*").text).toBe("the Lord spoke today")
    expect(usfmContentOnly("a\n\n\n\n\\p b").text).toBe("a\nb")
  })

  it("returns marker-free text unchanged (other than ~) so non-USFM cells are untouched", () => {
    expect(usfmContentOnly("  keep  my   spacing \n\n\n ok ")).toEqual({
      text: "  keep  my   spacing \n\n\n ok ",
      notes: [],
    })
  })
})
