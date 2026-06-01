import { describe, it, expect } from "vitest"
import { extractVttStrings, extractSrtStrings } from "./subtitle"

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
