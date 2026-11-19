// Sam, question 93: the Export dialog's "Mono loudness". With the meter
// choice, evened takes written to a MONO file are stamped so the one gain
// helper raises them 3 dB; stereo output and unevened takes are untouched.
import { describe, expect, it } from "vitest"
import { monoMeterHeldCount, withMonoLoudness } from "./mono-loudness"
import type { CellData } from "@/hooks/useCells"

const cells = [{
  id: "c1",
  attachments: {
    evened: { url: "u1", type: "audio", loudnessLufs: -26, truePeakDb: -14, evenTargetLufs: -16 },
    plain: { url: "u2", type: "audio", loudnessLufs: -26, truePeakDb: -14 },
  },
}] as unknown as CellData[]
const att = (c: CellData[], id: string) => (c[0].attachments as Record<string, { monoLoudness?: string }>)[id]

describe("withMonoLoudness", () => {
  it("as heard (the default): the cells as they are", () => {
    expect(withMonoLoudness(cells, "heard")).toBe(cells)
  })

  it("as a meter reads it: stamps the evened takes of a mono export, and only those", () => {
    const out = withMonoLoudness(cells, "meter")
    expect(att(out, "evened").monoLoudness).toBe("meter")
    expect(att(out, "plain").monoLoudness).toBeUndefined()
    expect(att(cells, "evened").monoLoudness).toBeUndefined()
  })

  it("leaves a stereo export as it is", () => {
    expect(withMonoLoudness(cells, "meter", { channels: 2 })).toBe(cells)
  })
})

// Re-check S4: how many evened takes can't reach the meter level (the peak
// ceiling or the +12 dB cap holds them back).
describe("monoMeterHeldCount", () => {
  it("counts the evened takes the meter reading would hold back, and nothing else", () => {
    const c = [{
      id: "c1",
      attachments: {
        fits: { url: "u1", type: "audio", loudnessLufs: -22, truePeakDb: -20, evenTargetLufs: -16 },
        peak: { url: "u2", type: "audio", loudnessLufs: -17, truePeakDb: -2, evenTargetLufs: -16 },
        cap: { url: "u3", type: "audio", loudnessLufs: -26, truePeakDb: -30, evenTargetLufs: -16 },
        plain: { url: "u4", type: "audio", loudnessLufs: -40, truePeakDb: -30 },
      },
    }] as unknown as CellData[]
    expect(monoMeterHeldCount(c)).toBe(2)
    expect(monoMeterHeldCount([{ id: "c2", attachments: { p: { url: "u", type: "audio", loudnessLufs: -40, truePeakDb: -30 } } }] as unknown as CellData[])).toBe(0)
  })
})
