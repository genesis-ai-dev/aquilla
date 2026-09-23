import { describe, it, expect } from "vitest"
import {
  extractVttStrings,
  extractSrtStrings,
  repairShortFormCueTimestamps,
} from "./subtitle"

describe("subtitle timecode extraction", () => {
  it("parses VTT cue start/end into numeric seconds and keeps the raw context", () => {
    const vtt = "WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nHello there\n"
    const [cue] = extractVttStrings(vtt)
    expect(cue.start).toBeCloseTo(1.5)
    expect(cue.end).toBeCloseTo(3.25)
    expect(cue.context).toBe("00:00:01.500 --> 00:00:03.250")
  })

  it("parses SRT comma-millisecond timecodes into seconds", () => {
    const srt = "1\n00:00:02,000 --> 00:00:04,000\nHi\n"
    const [cue] = extractSrtStrings(srt)
    expect(cue.start).toBeCloseTo(2)
    expect(cue.end).toBeCloseTo(4)
  })
})

describe("repairShortFormCueTimestamps", () => {
  it("pads a short-form cue so the parser stops swallowing it with its words", () => {
    const vtt = ["WEBVTT", "", "1", "01:03.209 --> 01:03.667", "Abba?", ""].join("\n")
    // The stock parser refuses the line outright — cue AND payload vanish.
    expect(extractVttStrings(vtt)).toEqual([])

    const { text, cueLines, repaired } = repairShortFormCueTimestamps(vtt)
    expect(cueLines).toBe(1)
    expect(repaired).toBe(1)
    const [cue] = extractVttStrings(text)
    expect(cue.original).toBe("Abba?")
    expect(cue.context).toBe("00:01:03.209 --> 00:01:03.667")
    expect(cue.start).toBeCloseTo(63.209)
  })

  it("counts an already-strict line without rewriting it", () => {
    const vtt = ["WEBVTT", "", "00:00:01.500 --> 00:00:03.250", "Hello", ""].join("\n")
    const { text, cueLines, repaired } = repairShortFormCueTimestamps(vtt)
    expect(cueLines).toBe(1)
    expect(repaired).toBe(0)
    expect(text).toBe(vtt)
  })

  it("pads every accepted short form and keeps cue settings verbatim", () => {
    const { text } = repairShortFormCueTimestamps("1:03.209 --> 0:01:03.667 align:start position:10%")
    expect(text).toBe("00:01:03.209 --> 00:01:03.667 align:start position:10%")
  })

  it("leaves lines that are not cue timestamps alone", () => {
    const vtt = ["WEBVTT", "", "NOTE 1:03.209 is not a cue", "", "00:00:01.000 --> 00:00:02.000", "Hi"].join("\n")
    expect(repairShortFormCueTimestamps(vtt).text).toBe(vtt)
  })
})
