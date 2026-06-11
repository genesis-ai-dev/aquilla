import { describe, it, expect } from "vitest"
import { cellTextForDisplay, truncateCellText } from "./cell-text"

describe("cellTextForDisplay", () => {
  it("returns plain text unchanged", () => {
    expect(cellTextForDisplay("Hello world")).toBe("Hello world")
  })

  it("unwraps JSON value wrappers", () => {
    expect(cellTextForDisplay('{"value":"Questo è testo in grassetto 90"}')).toBe(
      "Questo è testo in grassetto 90",
    )
  })

  it("returns original text when JSON has no value field", () => {
    expect(cellTextForDisplay('{"foo":"bar"}')).toBe('{"foo":"bar"}')
  })

  it("returns original text for invalid JSON", () => {
    expect(cellTextForDisplay("{not json}")).toBe("{not json}")
  })

  it("handles empty and nullish input", () => {
    expect(cellTextForDisplay("")).toBe("")
    expect(cellTextForDisplay(null)).toBe("")
    expect(cellTextForDisplay(undefined)).toBe("")
  })
})

describe("truncateCellText", () => {
  it("truncates long strings", () => {
    expect(truncateCellText("abcdefghij", 5)).toBe("abcde…")
  })

  it("leaves short strings unchanged", () => {
    expect(truncateCellText("hi", 5)).toBe("hi")
  })
})
