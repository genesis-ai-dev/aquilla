import { beforeAll, describe, expect, it } from "vitest"
import { omniLanguageFromTag, whisperLanguageFromTag } from "../lib/transcription-language"
import {
  OMNI_GPU_CENTS_PER_SEC, omniAmortization, omniCostBoundCents, omniRawCostCents,
} from "../../../db/shared/omni-asr-cost"

type Mapper = (tag: string | undefined | null) => string | undefined
let spaWhisper: Mapper
beforeAll(async () => {
  const path = new URL("../../../src/lib/audio/language.ts", import.meta.url).pathname
  ;({ whisperLanguageFromTag: spaWhisper } = await import(path))
})

describe("whisperLanguageFromTag (server copy)", () => {
  // The server now decides Whisper vs Omnilingual from the raw tag. If its copy
  // drifted from the SPA's, the on-device and hosted paths would disagree about
  // which languages Whisper handles.
  it("agrees with the SPA's mapping on every tag", () => {
    const tags = ["en", "en-US", "fr_CA", "fre", "ger", "zh-Hant", "tpi", "kmr", "xx", "deadbeef",
      "", "  ", "jw", "jv", "eng", "pus_x", "qxy-Latn", "sr-Cyrl-RS", "x-private"]
    for (const tag of tags) expect(whisperLanguageFromTag(tag), tag).toBe(spaWhisper(tag))
  })
})

describe("omniLanguageFromTag", () => {
  it("maps 639-1 to 639-3 with the default script", () => {
    expect(omniLanguageFromTag("en")).toBe("eng_Latn")
    expect(omniLanguageFromTag("ru")).toBe("rus_Cyrl")
    expect(omniLanguageFromTag("am-ET")).toBe("amh_Ethi")
  })
  it("honours an explicit script subtag over the default", () => {
    expect(omniLanguageFromTag("sr-Latn")).toBe("srp_Latn")
    expect(omniLanguageFromTag("zh-hant-TW")).toBe("cmn_Hant")
    expect(omniLanguageFromTag("qxy-Latn")).toBe("qxy_Latn")
  })
  it("normalises bibliographic 639-2 codes", () => {
    expect(omniLanguageFromTag("fre")).toBe("fra_Latn")
  })
  it("returns undefined rather than guessing an unknown script", () => {
    // The request then goes to CTC without lang (CTC has no conditioning).
    expect(omniLanguageFromTag("qxy")).toBeUndefined()
    expect(omniLanguageFromTag("deadbeef")).toBeUndefined()
    expect(omniLanguageFromTag(undefined)).toBeUndefined()
  })
})

describe("Omnilingual cost", () => {
  it("bounds a call at ceil(audio × max RTF + 30) GPU seconds", () => {
    expect(omniCostBoundCents("ctc", 30, 1.5)).toBeCloseTo(Math.ceil(30 * 0.5 + 30) * OMNI_GPU_CENTS_PER_SEC["NVIDIA L4"] * 1.5, 9)
    expect(omniCostBoundCents("zs", 30, 1.5)).toBeCloseTo(Math.ceil(30 * 2 + 30) * OMNI_GPU_CENTS_PER_SEC["NVIDIA L40S"] * 1.5, 9)
  })
  it("reserves more than the Modal spike's measured worst runs settle", () => {
    // Spike (spec §8): CTC ≈0.09, ZS 0.3–0.45 GPU-s per audio-s.
    expect(omniRawCostCents(30 * 0.09, "NVIDIA L4", 1.5)).toBeLessThan(omniCostBoundCents("ctc", 30, 1.5))
    expect(omniRawCostCents(30 * 0.45, "NVIDIA L40S", 1.5)).toBeLessThan(omniCostBoundCents("zs", 30, 1.5))
  })
  it("defaults amortization to 1.5 and refuses values that would discount", () => {
    expect(omniAmortization(undefined)).toBe(1.5)
    expect(omniAmortization("2")).toBe(2)
    for (const bad of ["0", "0.5", "abc", "-1"]) expect(() => omniAmortization(bad)).toThrow()
  })
})
