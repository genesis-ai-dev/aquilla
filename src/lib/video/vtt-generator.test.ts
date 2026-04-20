import { describe, it, expect } from "vitest"
import { generateVttFromCells, parseTimestampRange } from "./vtt-generator"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    original: "",
    translated: "",
    context: "",
    group: "",
    type: "cue",
    status: "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

describe("parseTimestampRange", () => {
  it("parses VTT-style timestamps", () => {
    const r = parseTimestampRange("00:00:01.500 --> 00:00:04.250")
    expect(r).toEqual({ start: 1.5, end: 4.25 })
  })

  it("parses SRT-style timestamps (comma)", () => {
    const r = parseTimestampRange("00:00:01,500 --> 00:00:04,250")
    expect(r).toEqual({ start: 1.5, end: 4.25 })
  })

  it("parses hours", () => {
    const r = parseTimestampRange("01:02:03.000 --> 01:02:05.000")
    expect(r).toEqual({ start: 3723, end: 3725 })
  })

  it("returns null for non-timestamp context", () => {
    expect(parseTimestampRange("Paragraph 1")).toBeNull()
    expect(parseTimestampRange("")).toBeNull()
    expect(parseTimestampRange("Genesis 1:1")).toBeNull()
  })
})

describe("generateVttFromCells", () => {
  it("emits WEBVTT header and one cue per cell", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", translated: "Bonjour", context: "00:00:01.000 --> 00:00:04.000" }),
      makeCell({ id: "c2", translated: "Au revoir", context: "00:00:05.000 --> 00:00:08.000" }),
    ]
    const out = generateVttFromCells(cells)
    expect(out).toContain("WEBVTT")
    expect(out).toContain("00:00:01.000 --> 00:00:04.000")
    expect(out).toContain("Bonjour")
    expect(out).toContain("00:00:05.000 --> 00:00:08.000")
    expect(out).toContain("Au revoir")
  })

  it("falls back to original text when translated is empty", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", original: "Hello", translated: "", context: "00:00:01.000 --> 00:00:04.000" }),
    ]
    const out = generateVttFromCells(cells)
    expect(out).toContain("Hello")
  })

  it("normalizes SRT commas to VTT dots in output", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", translated: "T", context: "00:00:01,500 --> 00:00:04,250" }),
    ]
    const out = generateVttFromCells(cells)
    expect(out).toContain("00:00:01.500 --> 00:00:04.250")
    expect(out).not.toContain(",500")
  })

  it("skips cells whose context is not a timestamp range", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", translated: "Skipme", context: "Paragraph 1" }),
      makeCell({ id: "c2", translated: "Keepme", context: "00:00:01.000 --> 00:00:04.000" }),
    ]
    const out = generateVttFromCells(cells)
    expect(out).not.toContain("Skipme")
    expect(out).toContain("Keepme")
  })

  it("handles empty input", () => {
    expect(generateVttFromCells([])).toBe("WEBVTT\n\n")
  })

  it("strips HTML tags from rich text", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", translated: "hello <b>world</b>", context: "00:00:01.000 --> 00:00:04.000" }),
    ]
    const out = generateVttFromCells(cells)
    expect(out).toContain("hello world")
    expect(out).not.toContain("<b>")
  })
})
