import { describe, it, expect } from "vitest"
import { extractSbvStrings } from "./sbv"

describe("extractSbvStrings", () => {
  it("parses cue blocks separated by blank lines", () => {
    const content = [
      "0:00:01.000,0:00:03.500",
      "Hello there",
      "",
      "0:00:04.000,0:00:06.000",
      "Second cue",
    ].join("\n")
    const cues = extractSbvStrings(content)
    expect(cues).toHaveLength(2)
    expect(cues[0].original).toBe("Hello there")
    expect(cues[1].original).toBe("Second cue")
  })

  it("converts timecodes to fractional seconds, including multi-digit hours", () => {
    const cues = extractSbvStrings("1:02:03.450,12:34:56.789\nText")
    expect(cues[0].start).toBeCloseTo(3723.45, 5)
    expect(cues[0].end).toBeCloseTo(45296.789, 5)
  })

  it("handles zero-hour timecodes and sub-second math", () => {
    const cues = extractSbvStrings("0:00:00.500,0:00:02.250\nText")
    expect(cues[0].start).toBeCloseTo(0.5, 5)
    expect(cues[0].end).toBeCloseTo(2.25, 5)
  })

  it("sets context to the raw timecode line, type cue, uuid id and group", () => {
    const [cue] = extractSbvStrings("0:00:01.000,0:00:02.000\nHi")
    expect(cue.context).toBe("0:00:01.000,0:00:02.000")
    expect(cue.type).toBe("cue")
    expect(cue.translated).toBe("")
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(cue.id).toMatch(uuidRe)
    expect(cue.group).toMatch(uuidRe)
    expect(cue.group).not.toBe(cue.id)
  })

  it("joins multi-line cue text with newlines", () => {
    const cues = extractSbvStrings("0:00:01.000,0:00:02.000\nLine one\nLine two\nLine three")
    expect(cues).toHaveLength(1)
    expect(cues[0].original).toBe("Line one\nLine two\nLine three")
  })

  it("skips malformed blocks silently (bad timecode, text-only block, timecode with no text)", () => {
    const content = [
      "not a timecode",
      "orphan text",
      "",
      "0:00:99,broken",
      "bad cue",
      "",
      "0:00:05.000,0:00:06.000",
      "",
      "0:00:07.000,0:00:08.000",
      "Good cue",
    ].join("\n")
    const cues = extractSbvStrings(content)
    expect(cues).toHaveLength(1)
    expect(cues[0].original).toBe("Good cue")
    expect(cues[0].start).toBe(7)
    expect(cues[0].end).toBe(8)
  })

  it("tolerates CRLF line endings and leading/trailing blank lines", () => {
    const cues = extractSbvStrings("\r\n0:00:01.000,0:00:02.000\r\nWindows text\r\n\r\n")
    expect(cues).toHaveLength(1)
    expect(cues[0].original).toBe("Windows text")
    expect(cues[0].start).toBe(1)
    expect(cues[0].end).toBe(2)
  })

  it("returns an empty array for empty or all-blank input", () => {
    expect(extractSbvStrings("")).toEqual([])
    expect(extractSbvStrings("\n\n  \n")).toEqual([])
  })
})
