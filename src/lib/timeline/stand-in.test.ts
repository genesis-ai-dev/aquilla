// AQU-2204: a line with no times takes a stand-in length from its words.
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import {
  defaultPaceCps,
  learnedPaceCps,
  PACE_ALPHABETIC_CPS,
  PACE_CJK_CPS,
  PACE_OTHER_CPS,
  standInEstimator,
  standInLenSec,
  STAND_IN_MAX_SEC,
  STAND_IN_MIN_SEC,
} from "./stand-in"

const line = (id: string, text: string, takeMs?: number): CellData =>
  ({
    id,
    fileId: "f1",
    medium: "text",
    original: text,
    translated: "",
    ...(takeMs != null
      ? {
          selectedAudioId: `audio-${id}-take.webm`,
          attachments: { [`audio-${id}-take.webm`]: { type: "audio", url: "frontier-audio://t", durationMs: takeMs } },
        }
      : {}),
  }) as unknown as CellData

describe("the default reading pace, by script", () => {
  it("reads alphabetic text at about 14 characters a second", () => {
    expect(defaultPaceCps("In the days when the judges ruled")).toBe(PACE_ALPHABETIC_CPS)
    expect(defaultPaceCps("В те дни, когда управляли судьи")).toBe(PACE_ALPHABETIC_CPS)
  })

  it("reads Chinese and Japanese at about 5 characters a second", () => {
    expect(defaultPaceCps("耶和华对何西阿说")).toBe(PACE_CJK_CPS)
    expect(defaultPaceCps("はじめに神は天と地を創造された")).toBe(PACE_CJK_CPS)
  })

  it("reads other scripts at about 12 characters a second", () => {
    expect(defaultPaceCps("دعني أسألك سؤالاً")).toBe(PACE_OTHER_CPS)
    expect(defaultPaceCps("ในสมัยที่ผู้วินิจฉัยปกครอง")).toBe(PACE_OTHER_CPS)
  })
})

describe("a stand-in length", () => {
  it("is the text's length at the pace", () => {
    // 28 characters at 14 a second.
    expect(standInLenSec("Naomi went back with Ruth...", 14)).toBeCloseTo(2, 5)
  })

  it("is kept between 1.5 and 12 seconds", () => {
    expect(standInLenSec("Amen.", 14)).toBe(STAND_IN_MIN_SEC)
    expect(standInLenSec("", 14)).toBe(STAND_IN_MIN_SEC)
    expect(standInLenSec("x".repeat(1000), 14)).toBe(STAND_IN_MAX_SEC)
  })
})

describe("the file's own pace", () => {
  it("is not trusted until 3 lines are recorded", () => {
    const two = [line("a", "x".repeat(20), 2_000), line("b", "x".repeat(20), 2_000), line("c", "y".repeat(30))]
    expect(learnedPaceCps(two)).toBeNull()
  })

  it("is the recorded lines' characters per second from 3 on", () => {
    // 60 characters over 6 s: 10 a second.
    const three = [
      line("a", "x".repeat(20), 2_000),
      line("b", "x".repeat(20), 2_000),
      line("c", "x".repeat(20), 2_000),
      line("d", "y".repeat(30)),
    ]
    expect(learnedPaceCps(three)).toBeCloseTo(10, 5)
  })

  it("replaces the script default for every unrecorded line", () => {
    const cells = [
      line("a", "x".repeat(20), 2_000),
      line("b", "x".repeat(20), 2_000),
      line("c", "x".repeat(20), 2_000),
      line("d", "y".repeat(40)),
    ]
    // 40 characters at the learned 10 a second, not the default 14.
    expect(standInEstimator(cells)(cells[3])).toBeCloseTo(4, 5)
  })

  it("falls back to each line's script default before then", () => {
    const cells = [line("d", "y".repeat(42))]
    expect(standInEstimator(cells)(cells[0])).toBeCloseTo(42 / PACE_ALPHABETIC_CPS, 5)
  })
})
