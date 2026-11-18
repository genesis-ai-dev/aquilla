import { beforeEach, describe, expect, it } from "vitest"
import { setTranscriptionModel } from "@/lib/audio/transcription-model"
import { getTranscribeSpeed, modelToWake, setTranscribeSpeed, speechChoice } from "./transcribe-speed"

beforeEach(() => {
  localStorage.clear()
  setTranscriptionModel("u", "auto")
})

describe("the lens's speed choice", () => {
  // Fast beats accurate for the first pass: the cleanup rewrites it anyway.
  it("is Fast until the person picks Smart, and remembers the pick per account", () => {
    expect(getTranscribeSpeed("u")).toBe("fast")
    setTranscribeSpeed("u", "smart")
    expect(getTranscribeSpeed("u")).toBe("smart")
    expect(getTranscribeSpeed("someone-else")).toBe("fast")
  })
})

describe("speechChoice", () => {
  it("runs the fast phonetic model for a language only Omnilingual has", () => {
    expect(speechChoice("fast", "u", "bla")).toEqual({ model: "omni-fast" })
  })

  // An unwritten language often has no code at all: a name, or nothing. The
  // automatic route would hand that to Whisper's auto-detect, which answers
  // in some other language. The phonetic model needs no language.
  it("runs the fast phonetic model when the language is a name or missing", () => {
    expect(speechChoice("fast", "u", "Tripuri")).toEqual({ model: "omni-fast" })
    expect(speechChoice("fast", "u", undefined)).toEqual({ model: "omni-fast" })
  })

  it("leaves a language Whisper knows on the automatic route, which is already quick", () => {
    expect(speechChoice("fast", "u", "es")).toEqual({ model: "auto" })
    expect(speechChoice("smart", "u", "es")).toEqual({ model: "auto" })
  })

  // Smart must never stop to ask: with no examples yet it quietly runs the
  // fast model, so the first rows of a project still get transcribed.
  it("runs zero-shot for Smart, falling back to the fast model without asking", () => {
    expect(speechChoice("smart", "u", "bla")).toEqual({ model: "omni-zs", quietFallback: "omni-fast" })
  })

  it("lets a model pinned in Preferences decide what Smart runs, and never what Fast runs", () => {
    setTranscriptionModel("u", "whisper")
    expect(speechChoice("smart", "u", "bla")).toEqual({ model: "whisper" })
    expect(speechChoice("fast", "u", "bla")).toEqual({ model: "omni-fast" })
  })
})

describe("modelToWake", () => {
  it("names the model to start as the lens opens, and none for Whisper or Qwen", () => {
    expect(modelToWake({ model: "omni-fast" }, "bla")).toBe("fast")
    expect(modelToWake({ model: "omni-zs", quietFallback: "omni-fast" }, "bla")).toBe("zs")
    expect(modelToWake({ model: "auto" }, "bla")).toBe("ctc")
    expect(modelToWake({ model: "auto" }, "es")).toBeNull()
    expect(modelToWake({ model: "whisper" }, "bla")).toBeNull()
  })
})
