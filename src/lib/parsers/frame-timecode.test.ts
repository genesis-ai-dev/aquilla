// AQU-2197: video timecode, and subtitle files whose times are frame numbers
// written as hundredths of a second (Come and See's re-delivered episode 101).
import { describe, expect, it } from "vitest"
import {
  convertFramesAsHundredths,
  convertFramesAsHundredthsSeconds,
  detectFramesAsHundredths,
  frameRateFor,
  frameRateLabelFor,
  parseTimecode,
  settledRate,
  timecodeToSeconds,
  type FramesAsHundredths,
} from "./frame-timecode"
import { parseTextFormat } from "./parse-text-formats"
import type { TranslatableString } from "./core-types"

describe("reading timecode", () => {
  it("reads HH:MM:SS:FF, and drop-frame's semicolon", () => {
    expect(parseTimecode("00:01:03:05")).toEqual({ hours: 0, minutes: 1, seconds: 3, frames: 5, dropFrame: false })
    expect(parseTimecode("01:00:10;02")?.dropFrame).toBe(true)
  })

  it("is not fooled by an ordinary time", () => {
    expect(parseTimecode("00:01:03.050")).toBeUndefined()
    expect(parseTimecode("00:61:03:05")).toBeUndefined()
    expect(parseTimecode("")).toBeUndefined()
  })

  it("turns a frame into its share of the second at the rate", () => {
    const tc = parseTimecode("00:01:06:15")!
    expect(timecodeToSeconds(tc, frameRateFor("24"))).toBeCloseTo(66.625, 6)
    expect(timecodeToSeconds(tc, frameRateFor("25"))).toBeCloseTo(66.6, 6)
    // 23.976 counts like 24 but runs 0.1% slow.
    expect(timecodeToSeconds(tc, frameRateFor("23.976"))).toBeCloseTo((66 * 24 + 15) * 1001 / 24000, 6)
  })

  it("rules out a rate whose frames the timecode exceeds", () => {
    expect(timecodeToSeconds(parseTimecode("00:00:01:24")!, frameRateFor("24"))).toBeUndefined()
    expect(timecodeToSeconds(parseTimecode("00:00:01:24")!, frameRateFor("25"))).toBeCloseTo(1.96, 6)
  })

  it("keeps drop-frame labels on the wall clock, and only at 29.97", () => {
    const tenMinutes = parseTimecode("00:10:00;00")!
    expect(timecodeToSeconds(tenMinutes, frameRateFor("29.97"))!).toBeCloseTo(600, 2)
    expect(timecodeToSeconds(tenMinutes, frameRateFor("30"))).toBeUndefined()
  })
})

/** Cues whose times are timecode frames written as hundredths, like their VTT. */
function framesAsHundredthsCues(n: number): TranslatableString[] {
  return Array.from({ length: n }, (_, i) => {
    const start = 60 + i * 3 + ((i * 7) % 24) / 100
    const end = start + 2 + ((i * 5) % 24) / 100 - (((i * 7) % 24) / 100)
    return { id: `c${i}`, original: `line ${i}`, translated: "", context: "", group: `g${i}`, type: "cue" as const, start, end }
  })
}

describe("noticing frames written as hundredths", () => {
  it("notices a file whose every time is a frame number in hundredths", () => {
    const found = detectFramesAsHundredths(framesAsHundredthsCues(40))
    expect(found).not.toBeNull()
    expect(found!.maxFrame).toBe(23)
    expect(found!.suggested).toBe("24")
    expect(found!.rates).toEqual(["23.976", "24", "25", "29.97", "30"])
  })

  it("leaves a properly timed file alone", () => {
    const real = framesAsHundredthsCues(40).map((c, i) => ({ ...c, start: c.start! + 0.417 * (i % 3), end: c.end! + 0.833 }))
    expect(detectFramesAsHundredths(real)).toBeNull()
  })

  it("does not read whole seconds, or a handful of cues, as proof", () => {
    const whole = framesAsHundredthsCues(40).map((c, i) => ({ ...c, start: 60 + i * 3, end: 62 + i * 3 }))
    expect(detectFramesAsHundredths(whole)).toBeNull()
    expect(detectFramesAsHundredths(framesAsHundredthsCues(10))).toBeNull()
  })

  it("suggests the rate the highest frame needs", () => {
    const cues = framesAsHundredthsCues(40)
    cues[3] = { ...cues[3], start: 70.24 }
    expect(detectFramesAsHundredths(cues)!.suggested).toBe("25")
    cues[5] = { ...cues[5], start: 80.28 }
    const found = detectFramesAsHundredths(cues)!
    expect(found.suggested).toBe("30")
    expect(found.rates).toEqual(["29.97", "30"])
  })
})

describe("converting at a frame rate", () => {
  it("converts one time, for rows that carry times outside a cue", () => {
    expect(convertFramesAsHundredthsSeconds(66.15, "24")).toBeCloseTo(66.625, 6)
    expect(convertFramesAsHundredthsSeconds(66.15, "25")).toBeCloseTo(66.6, 6)
  })

  it("moves each time to the frame's real place, and keeps everything else", () => {
    const cue: TranslatableString = {
      id: "a", original: "You should be sleeping, little one.", translated: "", group: "g", type: "cue",
      context: "00:01:06.150 --> 00:01:07.180 align:start", start: 66.15, end: 67.18, speaker: "FATHER",
    }
    const [out] = convertFramesAsHundredths([cue], "24")
    expect(out.start).toBeCloseTo(66.625, 6)
    expect(out.end).toBeCloseTo(67.75, 6)
    expect(out.context).toBe("00:01:06.625 --> 00:01:07.750 align:start")
    expect(out.original).toBe(cue.original)
    expect(out.speaker).toBe("FATHER")
    expect(out.id).toBe("a")
  })
})

describe("the subtitle import reports it (parse core)", () => {
  const vtt = (cues: Array<[string, string]>) =>
    "WEBVTT\n\n" + cues.map(([a, b], i) => `line-${i + 1}\n${a} --> ${b}\n<v A>Line ${i + 1}</v>`).join("\n\n") + "\n"
  const pad = (n: number) => String(n).padStart(2, "0")
  const at = (sec: number, frame: number) => `00:${pad(Math.floor(sec / 60))}:${pad(sec % 60)}.${pad(frame)}0`

  it("flags their kind of file", () => {
    const text = vtt(Array.from({ length: 24 }, (_, i) => [at(60 + i * 3, i % 24), at(62 + i * 3, (i * 5) % 24)]))
    const [result] = parseTextFormat({ fileType: "vtt", text, name: "101.vtt" })
    expect(result.framesAsHundredths?.suggested).toBe("24")
  })

  it("says nothing about an ordinary file", () => {
    const text = vtt(Array.from({ length: 24 }, (_, i) => [`00:01:${pad(i)}.417`, `00:01:${pad(i)}.833`]))
    const [result] = parseTextFormat({ fileType: "vtt", text, name: "ok.vtt" })
    expect(result.framesAsHundredths).toBeUndefined()
  })
})

describe("settling the rate to convert at", () => {
  const finding = (maxFrame: number, times: number): FramesAsHundredths => ({
    times, maxFrame, suggested: maxFrame <= 23 ? "24" : maxFrame <= 24 ? "25" : "30",
    rates: (["23.976", "24", "25", "29.97", "30"] as const).filter((label) => frameRateFor(label).nominal > maxFrame),
  })

  it("names a measured rate as the rate it is, and nothing else", () => {
    expect(frameRateLabelFor(24000 / 1001)).toBe("23.976")
    expect(frameRateLabelFor(25.0)).toBe("25")
    expect(frameRateLabelFor(29.97)).toBe("29.97")
    expect(frameRateLabelFor(50)).toBeNull()
    expect(frameRateLabelFor(Number.NaN)).toBeNull()
  })

  // The frame numbers alone cannot tell 24 from 23.976; the film can.
  it("takes the linked film's rate when it fits the frame numbers", () => {
    expect(settledRate(finding(23, 1116), "23.976")).toEqual({ rate: "23.976", from: "film" })
    expect(settledRate(finding(23, 1116), "24")).toEqual({ rate: "24", from: "film" })
  })

  it("uses the rate the frame numbers imply without a film", () => {
    expect(settledRate(finding(23, 1116), null)).toEqual({ rate: "24", from: "frames" })
    expect(settledRate(finding(24, 1116), undefined)).toEqual({ rate: "25", from: "frames" })
    expect(settledRate(finding(27, 1116), null)).toEqual({ rate: "30", from: "frames" })
  })

  it("does not take a film rate the frame numbers exceed", () => {
    expect(settledRate(finding(24, 1116), "24")).toEqual({ rate: "25", from: "frames" })
    expect(settledRate(finding(24, 40), "23.976")).toEqual({ rate: "25", from: "frames" })
  })

  // Episode 101: the streamed film runs at 25, but across 1,116 times the VTT
  // never shows frame 24, so its timecode counted 24 a second.
  it("does not take a film rate whose top frame a long file never shows", () => {
    expect(settledRate(finding(23, 1116), "25")).toEqual({ rate: "24", from: "frames" })
    expect(settledRate(finding(23, 1116), "30")).toEqual({ rate: "24", from: "frames" })
  })

  it("believes the film over a short file, which proves nothing either way", () => {
    expect(settledRate(finding(23, 48), "25")).toEqual({ rate: "25", from: "film" })
  })
})
