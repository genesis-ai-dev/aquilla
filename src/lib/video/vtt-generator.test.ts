import { describe, it, expect } from "vitest"
import { generateVttFromCells, generateSrtFromCells, parseTimestampRange } from "./vtt-generator"
import { extractVttStrings, extractSrtStrings } from "@/lib/parsers/subtitle"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    original: "",
    translated: "",
    fileId: "test-file",
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

describe("generateSrtFromCells", () => {
  it("emits sequential cue numbers with comma timestamps", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", translated: "Bonjour", context: "00:00:01.000 --> 00:00:04.000" }),
      makeCell({ id: "c2", translated: "Au revoir", context: "00:00:05.000 --> 00:00:08.000" }),
    ]
    const out = generateSrtFromCells(cells)
    expect(out).toContain("1\n00:00:01,000 --> 00:00:04,000\nBonjour")
    expect(out).toContain("2\n00:00:05,000 --> 00:00:08,000\nAu revoir")
    expect(out).not.toContain("WEBVTT")
  })

  it("falls back to original text when translated is empty", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", original: "Hello", translated: "", context: "00:00:01.000 --> 00:00:04.000" }),
    ]
    expect(generateSrtFromCells(cells)).toContain("Hello")
  })

  it("accepts SRT-context cells (commas) and outputs SRT format", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", translated: "T", context: "00:00:01,500 --> 00:00:04,250" }),
    ]
    const out = generateSrtFromCells(cells)
    expect(out).toContain("00:00:01,500 --> 00:00:04,250")
  })

  it("skips cells whose context is not a timestamp range", () => {
    const cells: CellData[] = [
      makeCell({ id: "c1", translated: "Skip", context: "Paragraph 1" }),
      makeCell({ id: "c2", translated: "Keep", context: "00:00:01.000 --> 00:00:04.000" }),
    ]
    const out = generateSrtFromCells(cells)
    expect(out).not.toContain("Skip")
    expect(out).toContain("1\n")
    expect(out).toContain("Keep")
  })

  it("returns empty string for empty input", () => {
    expect(generateSrtFromCells([])).toBe("")
  })
})

describe("VTT round-trip fidelity", () => {
  const VTT_SOURCE = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.500 --> 00:00:09.750
Second cue`

  it("preserves timing after import → translate → export", () => {
    const parsed = extractVttStrings(VTT_SOURCE)
    // Simulate translation
    const cells: CellData[] = parsed.map((s) =>
      makeCell({ id: s.id, original: s.original, translated: "Translated: " + s.original, context: s.context })
    )
    const out = generateVttFromCells(cells)
    expect(out).toContain("00:00:01.000 --> 00:00:04.000")
    expect(out).toContain("00:00:05.500 --> 00:00:09.750")
    expect(out).toContain("Translated: Hello world")
    expect(out).toContain("Translated: Second cue")
    expect(out.startsWith("WEBVTT")).toBe(true)
  })

  it("round-trip produces parseable VTT with same cue count", () => {
    const parsed = extractVttStrings(VTT_SOURCE)
    const cells: CellData[] = parsed.map((s) =>
      makeCell({ id: s.id, original: s.original, translated: s.original, context: s.context })
    )
    const exported = generateVttFromCells(cells)
    const reparsed = extractVttStrings(exported)
    expect(reparsed).toHaveLength(parsed.length)
    reparsed.forEach((cue, i) => {
      expect(cue.context).toBe(parsed[i].context)
      expect(cue.original).toBe(parsed[i].original)
    })
  })
})

describe("SRT round-trip fidelity", () => {
  const SRT_SOURCE = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:09,750
Second cue`

  it("preserves timing after import → translate → export", () => {
    const parsed = extractSrtStrings(SRT_SOURCE)
    const cells: CellData[] = parsed.map((s) =>
      makeCell({ id: s.id, original: s.original, translated: "Traduit: " + s.original, context: s.context })
    )
    const out = generateSrtFromCells(cells)
    expect(out).toContain("00:00:01,000 --> 00:00:04,000")
    expect(out).toContain("00:00:05,500 --> 00:00:09,750")
    expect(out).toContain("Traduit: Hello world")
    expect(out).toContain("Traduit: Second cue")
  })

  it("round-trip produces parseable SRT with same cue count and timing", () => {
    const parsed = extractSrtStrings(SRT_SOURCE)
    const cells: CellData[] = parsed.map((s) =>
      makeCell({ id: s.id, original: s.original, translated: s.original, context: s.context })
    )
    const exported = generateSrtFromCells(cells)
    const reparsed = extractSrtStrings(exported)
    expect(reparsed).toHaveLength(parsed.length)
    reparsed.forEach((cue, i) => {
      expect(cue.context).toBe(parsed[i].context)
      expect(cue.original).toBe(parsed[i].original)
    })
  })
})
