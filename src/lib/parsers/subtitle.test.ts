import { describe, it, expect } from "vitest"
import { extractVttStrings, extractSrtStrings } from "./subtitle"

describe("extractVttStrings", () => {
  it("parses VTT cues", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
This is a test`

    const result = extractVttStrings(vtt)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].context).toBe("00:00:01.000 --> 00:00:04.000")
    expect(result[0].type).toBe("cue")
    expect(result[1].original).toBe("This is a test")
    expect(result[1].context).toBe("00:00:05.000 --> 00:00:08.000")
  })

  it("handles multi-line cue text", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Line one
Line two`

    const result = extractVttStrings(vtt)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Line one\nLine two")
  })

  it("handles empty input", () => {
    expect(extractVttStrings("WEBVTT")).toHaveLength(0)
  })

  it("sets translated equal to original", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello`

    const result = extractVttStrings(vtt)
    expect(result[0].translated).toBe("")
  })
})

describe("extractSrtStrings", () => {
  it("parses SRT cues", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,000
This is a test`

    const result = extractSrtStrings(srt)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].context).toBe("00:00:01,000 --> 00:00:04,000")
    expect(result[0].type).toBe("cue")
    expect(result[1].original).toBe("This is a test")
  })

  it("handles multi-line cue text", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two`

    const result = extractSrtStrings(srt)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Line one\nLine two")
  })

  it("handles empty input", () => {
    expect(extractSrtStrings("")).toHaveLength(0)
  })
})
