import { describe, it, expect } from "vitest"
import { stripTrailingBareMarkers } from "./strip-trailing-usfm-markers"

describe("stripTrailingBareMarkers", () => {
  it.each(["\\p", "\\m", "\\q", "\\q1", "\\b", "\\nb", "\\pi1", "\\li2"])(
    "strips a trailing bare %s",
    (marker) => {
      expect(stripTrailingBareMarkers(`First verse.\n${marker}`)).toBe("First verse.")
    },
  )

  it("strips repeated markers and the whitespace around them", () => {
    expect(stripTrailingBareMarkers("First verse.\n\\p\n\\q1 \n\n\\b\n  ")).toBe("First verse.")
  })

  it("handles CRLF line endings", () => {
    expect(stripTrailingBareMarkers("First verse.\r\n\\p\r\n")).toBe("First verse.")
  })

  it("returns an empty string for marker-only text", () => {
    expect(stripTrailingBareMarkers("\\p")).toBe("")
    expect(stripTrailingBareMarkers("\\p\n\\b")).toBe("")
  })

  it("keeps a mid-text marker", () => {
    expect(stripTrailingBareMarkers("One.\n\\p\nTwo.")).toBe("One.\n\\p\nTwo.")
    expect(stripTrailingBareMarkers("One.\n\\p\nTwo.\n\\p")).toBe("One.\n\\p\nTwo.")
  })

  it("keeps content-bearing markers", () => {
    expect(stripTrailingBareMarkers("One.\n\\q1 Two.")).toBe("One.\n\\q1 Two.")
    expect(stripTrailingBareMarkers("One.\n\\p Two.")).toBe("One.\n\\p Two.")
  })

  it("keeps markers outside the listed set", () => {
    expect(stripTrailingBareMarkers("One.\n\\pn")).toBe("One.\n\\pn")
    expect(stripTrailingBareMarkers("One.\n\\pc")).toBe("One.\n\\pc")
    expect(stripTrailingBareMarkers("One.\n\\q12")).toBe("One.\n\\q12")
  })

  it("keeps footnote text", () => {
    const withNote = "One.\\f + \\ft A note.\\f* Two."
    expect(stripTrailingBareMarkers(withNote)).toBe(withNote)
    expect(stripTrailingBareMarkers(`${withNote}\n\\p`)).toBe(withNote)
  })

  it("returns clean text unchanged, including its whitespace", () => {
    expect(stripTrailingBareMarkers("Plain text. \n")).toBe("Plain text. \n")
    expect(stripTrailingBareMarkers("")).toBe("")
  })
})
