import { describe, expect, it } from "vitest"
import { createMediaCueSpecs } from "./media-cues"
import type { TranslatableString } from "../parsers/core-types"

function cue(start: number, end: number, original = "Wording"): TranslatableString {
  return { id: "cue", original, translated: "", context: "", group: "", type: "cue", start, end }
}

describe("reviewed media cue preparation", () => {
  it("orders cues by time and preserves gaps, overlaps and confidence", () => {
    const later = { ...cue(2, 4, "Later"), metadata: { alignmentConfidence: 0.8 } }
    expect(createMediaCueSpecs([later, cue(0.5, 3, "Earlier")], 5000)).toEqual([
      expect.objectContaining({ transcription: "Earlier", startMs: 500, endMs: 3000,
        trimStartMs: 500, trimEndMs: 3000 }),
      expect.objectContaining({ transcription: "Later", startMs: 2000, endMs: 4000,
        metadata: { alignmentConfidence: 0.8 } }),
    ])
  })

  it.each([
    cue(-1, 1), cue(2, 1), cue(Number.NaN, 1), cue(0, Number.POSITIVE_INFINITY),
    cue(1, 1), cue(1, 1.000001), cue(0, 1, " "), cue(0, 10),
  ])("refuses invalid cues before import: %j", invalid => {
    expect(() => createMediaCueSpecs([invalid], 2000)).toThrow()
  })

  it("refuses an empty wording source", () => {
    expect(() => createMediaCueSpecs([])).toThrow()
  })

  it("refuses timing that cannot be represented as safe integer milliseconds", () => {
    expect(() => createMediaCueSpecs([cue(0, Number.MAX_SAFE_INTEGER)])).toThrow()
  })
})
