import { beforeAll, describe, expect, it } from "vitest"
import { pickAsrModel, toOmniCode, toQwenCode, toWhisperCode } from "../../../db/shared/asr-models"
import {
  OMNI_GPU_CENTS_PER_SEC, omniAmortization, omniCostBoundCents, omniRawCostCents,
} from "../../../db/shared/omni-asr-cost"

type Mapper = (tag: string | undefined | null) => string | undefined
let spaWhisper: Mapper
beforeAll(async () => {
  const path = new URL("../../../src/lib/audio/language.ts", import.meta.url).pathname
  ;({ whisperLanguageFromTag: spaWhisper } = await import(path))
})

describe("toWhisperCode (server copy)", () => {
  // The server now decides Whisper vs Omnilingual from the raw tag. If its copy
  // drifted from the SPA's, the on-device and hosted paths would disagree about
  // which languages Whisper handles.
  it("agrees with the SPA's mapping on every tag", () => {
    const tags = ["en", "en-US", "fr_CA", "fre", "ger", "zh-Hant", "tpi", "kmr", "xx", "deadbeef",
      "", "  ", "jw", "jv", "eng", "pus_x", "qxy-Latn", "sr-Cyrl-RS", "x-private"]
    for (const tag of tags) expect(toWhisperCode(tag), tag).toBe(spaWhisper(tag))
  })
})

describe("pickAsrModel (spec §1)", () => {
  it("keeps Whisper for its languages, so existing users see no change", () => {
    for (const tag of ["sw", "en-US", "fr", "fra", "es-419"]) expect(pickAsrModel(tag), tag).toBe("whisper")
  })
  it("sends Chinese varieties, and only those, to Qwen3-ASR", () => {
    // Ryder: "Keep Whisper as the default for its languages; Qwen only for Chinese varieties."
    for (const tag of ["zh", "zh-Hant-TW", "yue", "cmn", "wuu", "nan", "hak"]) expect(pickAsrModel(tag), tag).toBe("qwen3-asr")
    for (const tag of ["ja", "ko", "vi"]) expect(pickAsrModel(tag), tag).toBe("whisper")
  })
  it("sends a language Whisper lacks to Omnilingual CTC", () => {
    for (const tag of ["tpi", "luo", "qxy-Latn"]) expect(pickAsrModel(tag), tag).toBe("omni-ctc")
  })
  it("falls back to Whisper auto-detect when there is no language code", () => {
    for (const tag of [undefined, "", "deadbeef", "x-private"]) expect(pickAsrModel(tag), String(tag)).toBe("whisper")
  })
  it("maps Cantonese to yue and other Chinese varieties to zh for Qwen", () => {
    expect(toQwenCode("yue-HK")).toBe("yue")
    expect(toQwenCode("cmn")).toBe("zh")
    expect(toQwenCode("fr")).toBeUndefined()
  })
})

describe("toOmniCode", () => {
  it("maps 639-1 to 639-3 with the default script", () => {
    expect(toOmniCode("en")).toBe("eng_Latn")
    expect(toOmniCode("ru")).toBe("rus_Cyrl")
    expect(toOmniCode("am-ET")).toBe("amh_Ethi")
  })
  it("honours an explicit script subtag over the default", () => {
    expect(toOmniCode("sr-Latn")).toBe("srp_Latn")
    expect(toOmniCode("zh-hant-TW")).toBe("cmn_Hant")
    expect(toOmniCode("qxy-Latn")).toBe("qxy_Latn")
  })
  it("normalises bibliographic 639-2 codes", () => {
    expect(toOmniCode("fre")).toBe("fra_Latn")
  })
  it("returns undefined rather than guessing an unknown script", () => {
    // The request then goes to CTC without lang (CTC has no conditioning).
    expect(toOmniCode("qxy")).toBeUndefined()
    expect(toOmniCode("deadbeef")).toBeUndefined()
    expect(toOmniCode(undefined)).toBeUndefined()
  })
})

describe("Omnilingual cost", () => {
  it("bounds a call at ceil(audio × max RTF + 30) GPU seconds", () => {
    expect(omniCostBoundCents("ctc", 30, 1.5)).toBeCloseTo(Math.ceil(30 * 0.5 + 30) * OMNI_GPU_CENTS_PER_SEC["NVIDIA A10G"] * 1.5, 9)
    expect(omniCostBoundCents("zs", 30, 1.5)).toBeCloseTo(Math.ceil(30 * 2 + 30) * OMNI_GPU_CENTS_PER_SEC["NVIDIA L40S"] * 1.5, 9)
  })
  it("reserves more than the Modal spike's measured worst runs settle", () => {
    // Spike (spec §8): CTC ≈0.09, ZS 0.3–0.45 GPU-s per audio-s.
    expect(omniRawCostCents(30 * 0.09, "NVIDIA L4", 1.5)).toBeLessThan(omniCostBoundCents("ctc", 30, 1.5))
    expect(omniRawCostCents(30 * 0.09, "NVIDIA A10G", 1.5)).toBeLessThan(omniCostBoundCents("ctc", 30, 1.5))
    expect(omniRawCostCents(30 * 0.45, "NVIDIA L40S", 1.5)).toBeLessThan(omniCostBoundCents("zs", 30, 1.5))
  })
  it("defaults amortization to 1.5 and refuses values that would discount", () => {
    expect(omniAmortization(undefined)).toBe(1.5)
    expect(omniAmortization("2")).toBe(2)
    for (const bad of ["0", "0.5", "abc", "-1"]) expect(() => omniAmortization(bad)).toThrow()
  })
})
