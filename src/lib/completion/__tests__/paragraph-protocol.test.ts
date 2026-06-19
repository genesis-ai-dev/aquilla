import { describe, it, expect } from "vitest"
import { encodeParagraphCells, parseParagraphResponse } from "../paragraph-protocol"

// Stable UUID-shaped ids used across tests
const ID_A = "11111111-1111-1111-1111-111111111111"
const ID_B = "22222222-2222-2222-2222-222222222222"
const ID_C = "33333333-3333-3333-3333-333333333333"

describe("encodeParagraphCells", () => {
  it("wraps each cell in a <c id> tag, one per line", () => {
    const result = encodeParagraphCells([
      { cellId: ID_A, text: "Hello world" },
      { cellId: ID_B, text: "Second line" },
    ])
    expect(result).toBe(
      `<c id="${ID_A}">Hello world</c>\n<c id="${ID_B}">Second line</c>`,
    )
  })

  it("returns empty string for an empty input", () => {
    expect(encodeParagraphCells([])).toBe("")
  })
})

describe("parseParagraphResponse", () => {
  it("round-trips: encode → parse returns the same per-cell text", () => {
    const cells = [
      { cellId: ID_A, text: "Verse one text" },
      { cellId: ID_B, text: "Verse two text" },
    ]
    const encoded = encodeParagraphCells(cells)
    const result = parseParagraphResponse(encoded, [ID_A, ID_B])
    expect(result.mapped).toEqual([
      { cellId: ID_A, text: "Verse one text" },
      { cellId: ID_B, text: "Verse two text" },
    ])
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
  })

  it("a response MISSING one expected cell → it appears in missing, not mapped", () => {
    const response = `<c id="${ID_A}">Found</c>`
    const result = parseParagraphResponse(response, [ID_A, ID_B])
    expect(result.mapped).toEqual([{ cellId: ID_A, text: "Found" }])
    expect(result.missing).toEqual([ID_B])
    expect(result.extra).toEqual([])
  })

  it("a response with an EXTRA unexpected id → it appears in extra", () => {
    const response = `<c id="${ID_A}">A</c>\n<c id="${ID_C}">Unexpected</c>`
    const result = parseParagraphResponse(response, [ID_A])
    expect(result.mapped).toEqual([{ cellId: ID_A, text: "A" }])
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([ID_C])
  })

  it("reordered tags in response still map to the right cell id and mapped is in EXPECTED order", () => {
    // Response has B before A, but expected order is A, B
    const response = `<c id="${ID_B}">B text</c>\n<c id="${ID_A}">A text</c>`
    const result = parseParagraphResponse(response, [ID_A, ID_B])
    expect(result.mapped).toEqual([
      { cellId: ID_A, text: "A text" },
      { cellId: ID_B, text: "B text" },
    ])
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
  })

  it("whitespace/newlines inside a cell's text are preserved (trimmed at boundaries)", () => {
    const response = `<c id="${ID_A}">\n  Line one\n  Line two\n</c>`
    const result = parseParagraphResponse(response, [ID_A])
    expect(result.mapped[0].text).toBe("Line one\n  Line two")
  })

  it("handles multi-line text content with internal newlines", () => {
    const response = `<c id="${ID_A}">First line\nSecond line\nThird line</c>`
    const result = parseParagraphResponse(response, [ID_A])
    expect(result.mapped[0].text).toBe("First line\nSecond line\nThird line")
  })

  it("returns all missing when response has no tags", () => {
    const result = parseParagraphResponse("no tags here", [ID_A, ID_B])
    expect(result.mapped).toEqual([])
    expect(result.missing).toEqual([ID_A, ID_B])
    expect(result.extra).toEqual([])
  })

  it("returns empty result for empty expected list with no tags", () => {
    const result = parseParagraphResponse("", [])
    expect(result).toEqual({ mapped: [], missing: [], extra: [] })
  })

  it("extra tags from empty expected list are reported", () => {
    const response = `<c id="${ID_A}">text</c>`
    const result = parseParagraphResponse(response, [])
    expect(result.extra).toEqual([ID_A])
    expect(result.mapped).toEqual([])
    expect(result.missing).toEqual([])
  })
})
