// Sam, question 93: the Export dialog's "Mono loudness". With the meter
// choice, evened takes written to a MONO file are stamped so the one gain
// helper raises them 3 dB; stereo output and unevened takes are untouched.
import { describe, expect, it } from "vitest"
import { withMonoLoudness } from "./mono-loudness"
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
