import { describe, expect, it } from "vitest"
import {
  bothApprovedFromHistogram,
  deliversRecordsAudio,
  laneCounting,
  laneCountsAudio,
  laneCountsText,
  laneLineDone,
  laneLineStarted,
  laneMeasure,
  laneRowDelivers,
  parseLaneDelivers,
  type LaneLineState,
  type LaneTallies,
} from "./lane-delivers"

const line = (overrides: Partial<LaneLineState> = {}): LaneLineState => ({
  textFilled: false,
  textValidated: false,
  recorded: false,
  audioApproved: false,
  ...overrides,
})

/** P1.6's ten lines, French set to Text and audio, both thresholds at 1. */
const P16_LINES: LaneLineState[] = [
  ...Array.from({ length: 4 }, () =>
    line({ textFilled: true, textValidated: true, recorded: true, audioApproved: true })),
  ...Array.from({ length: 3 }, () => line({ textFilled: true, textValidated: true })),
  ...Array.from({ length: 2 }, () => line({ textFilled: true, recorded: true, audioApproved: true })),
  line(),
]

describe("what counts as done in a lane", () => {
  it("Text: a line is done when its text is validated, whatever its recording", () => {
    expect(laneLineDone("text", line({ textValidated: true }))).toBe(true)
    expect(laneLineDone("text", line({ audioApproved: true }))).toBe(false)
  })

  it("Audio: a line is done when its recording is approved, and text plays no part", () => {
    expect(laneLineDone("audio", line({ audioApproved: true }))).toBe(true)
    expect(laneLineDone("audio", line({ textValidated: true }))).toBe(false)
    expect(laneLineStarted("audio", line({ recorded: true }))).toBe(true)
    expect(laneLineStarted("audio", line({ textFilled: true }))).toBe(false)
  })

  it("Text and audio: a line is done only when both its text and its recording are approved (P1.6)", () => {
    expect(P16_LINES.filter((l) => laneLineDone("text_and_audio", l))).toHaveLength(4)
    expect(laneLineStarted("text_and_audio", line({ recorded: true }))).toBe(true)
    expect(laneLineStarted("text_and_audio", line({ textFilled: true }))).toBe(true)
    expect(laneLineStarted("text_and_audio", line())).toBe(false)
  })

  it("a language nobody has chosen for counts exactly as Text, which is today's rule", () => {
    for (const l of P16_LINES) {
      expect(laneLineDone(null, l)).toBe(laneLineDone("text", l))
      expect(laneLineStarted(undefined, l)).toBe(laneLineStarted("text", l))
    }
    expect(laneCounting(null)).toBe("text")
    expect(laneCountsText(null)).toBe(true)
    expect(laneCountsAudio(null)).toBe(false)
  })

  it("says which halves each choice counts", () => {
    expect([laneCountsText("audio"), laneCountsAudio("audio")]).toEqual([false, true])
    expect([laneCountsText("text_and_audio"), laneCountsAudio("text_and_audio")]).toEqual([true, true])
    expect([laneCountsText("text"), laneCountsAudio("text")]).toEqual([true, false])
  })
})

describe("the aggregate rule agrees with the line rule", () => {
  /** Tallies built from lines, the way the progress rows count them. */
  function tallies(lines: LaneLineState[], audioTotal = lines.length): LaneTallies {
    return {
      total: lines.length,
      filled: lines.filter((l) => l.textFilled).length,
      validated: lines.filter((l) => l.textValidated).length,
      audioTotal,
      recorded: lines.filter((l) => l.recorded).length,
      audioApproved: lines.filter((l) => l.audioApproved).length,
      bothApproved: lines.filter((l) => l.textValidated && l.audioApproved).length,
    }
  }

  it.each(["text", "audio", "text_and_audio", null] as const)("%s: done lines are the same either way", (delivers) => {
    const measure = laneMeasure(delivers, tallies(P16_LINES))
    expect(measure.done).toBe(P16_LINES.filter((l) => laneLineDone(delivers, l)).length)
    expect(measure.started > 0).toBe(P16_LINES.some((l) => laneLineStarted(delivers, l)))
    expect(measure.total).toBe(10)
  })

  it("existing languages read the same numbers as before: Text is total / filled / validated", () => {
    const t = tallies(P16_LINES)
    for (const delivers of ["text", null, undefined] as const) {
      expect(laneMeasure(delivers, t)).toEqual({ total: 10, started: 9, done: 7, headline: 9 })
    }
  })

  it("Audio measures against its own denominator (a cue sheet) and heads with the approved lines (gap 2)", () => {
    const m = laneMeasure("audio", { ...tallies(P16_LINES), audioTotal: 40 })
    expect(m).toEqual({ total: 40, started: 6, done: 6, headline: 6 })
  })

  it("Text and audio heads with the lines done on both halves", () => {
    expect(laneMeasure("text_and_audio", tallies(P16_LINES))).toEqual({ total: 10, started: 9, done: 4, headline: 4 })
  })

  it("P1.3: 21 of 22 verses approved by two people reads 95.5% complete", () => {
    const m = laneMeasure("audio", {
      total: 22, filled: 0, validated: 0, audioTotal: 22, recorded: 22, audioApproved: 21, bothApproved: 0,
    })
    expect(Math.round((m.headline / m.total) * 1000) / 10).toBe(95.5)
  })
})

describe("the joint text × audio histogram", () => {
  const histogram = { "0:0": 3, "1:0": 2, "1:1": 4, "2:1": 1, "1:2": 5, "2:2": 6 }

  it("counts the lines that reach both thresholds", () => {
    expect(bothApprovedFromHistogram(histogram, 1, 1)).toBe(4 + 1 + 5 + 6)
    expect(bothApprovedFromHistogram(histogram, 2, 2)).toBe(6)
    expect(bothApprovedFromHistogram(histogram, 1, 2)).toBe(5 + 6)
    expect(bothApprovedFromHistogram(histogram, 2, 1)).toBe(1 + 6)
  })

  it("reads a JSON string, and treats anything malformed as nothing", () => {
    expect(bothApprovedFromHistogram(JSON.stringify(histogram), 2, 2)).toBe(6)
    expect(bothApprovedFromHistogram(null, 1, 1)).toBe(0)
    expect(bothApprovedFromHistogram("not json", 1, 1)).toBe(0)
    expect(bothApprovedFromHistogram({ "1": 3, "x:1": 2, "1:1": -2 }, 1, 1)).toBe(0)
  })
})

describe("the stored choice", () => {
  it("parses only the three choices", () => {
    expect(parseLaneDelivers("audio")).toBe("audio")
    expect(parseLaneDelivers("video")).toBeNull()
    expect(parseLaneDelivers(null)).toBeNull()
  })

  it("implies Records audio for the two choices that deliver audio", () => {
    expect(deliversRecordsAudio("text")).toBe(false)
    expect(deliversRecordsAudio("audio")).toBe(true)
    expect(deliversRecordsAudio("text_and_audio")).toBe(true)
  })

  it("reads an older server's row from Records audio, as migration 0186 does", () => {
    expect(laneRowDelivers({ recordsAudio: false })).toBe("text")
    expect(laneRowDelivers({ recordsAudio: true })).toBeNull()
    expect(laneRowDelivers({ recordsAudio: true, delivers: "audio" })).toBe("audio")
    expect(laneRowDelivers({ recordsAudio: false, delivers: null })).toBeNull()
  })
})
