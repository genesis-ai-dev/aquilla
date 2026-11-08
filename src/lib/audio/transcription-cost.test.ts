import { describe, expect, it } from "vitest"
import {
  audioMinutes, estimateTranscriptionCost, hostedRunSeconds, resolveSourceModel, roundedDuration,
} from "./transcription-cost"

const min = (m: number, s = 0) => (m * 60 + s) * 1000

describe("estimateTranscriptionCost (AQU-2426, board 58)", () => {
  it("one 52-minute recording: 53 requests, one for each minute, about 4 minutes", () => {
    const cost = estimateTranscriptionCost({ durationsMs: [min(52, 14)], chosenModel: "auto", languageTag: "en", onDevice: false })
    expect(cost.requests).toBe(53)
    expect(cost.model).toBe("whisper")
    expect(cost.automatic).toBe(true)
    expect(cost.waitsAtLimit).toBe(false)
    expect(roundedDuration(cost.seconds)).toEqual({ minutes: 4 })
    expect(audioMinutes(cost.audioMs)).toBe(52)
  })

  it("three recordings together: 102 requests, past the limit, about 20 minutes", () => {
    const cost = estimateTranscriptionCost({
      durationsMs: [min(52, 14), min(47, 26), min(0, 40)], chosenModel: "auto", languageTag: "en", onDevice: false,
    })
    expect(cost.requests).toBe(102)
    expect(cost.recordings).toBe(3)
    expect(cost.waitsAtLimit).toBe(true)
    expect(roundedDuration(cost.seconds)).toEqual({ minutes: 20 })
  })

  it("Omnilingual takes 30 seconds a request, so two for each minute", () => {
    const cost = estimateTranscriptionCost({ durationsMs: [min(10)], chosenModel: "omni-ctc", onDevice: false })
    expect(cost.windowSec).toBe(30)
    expect(cost.requests).toBe(20)
  })

  it("on this device: no requests and no wait", () => {
    const cost = estimateTranscriptionCost({ durationsMs: [min(52)], chosenModel: "auto", onDevice: true })
    expect(cost.onDevice).toBe(true)
    expect(cost.requests).toBe(0)
    expect(cost.seconds).toBe(0)
  })

  it("a recording of unknown length counts as one request", () => {
    expect(estimateTranscriptionCost({ durationsMs: [undefined], chosenModel: "whisper", onDevice: false }).requests).toBe(1)
  })
})

describe("resolveSourceModel", () => {
  it("resolves Automatic the way the server routes it", () => {
    expect(resolveSourceModel("auto", "en")).toBe("whisper")
    expect(resolveSourceModel("auto", "zh-Hans")).toBe("qwen3-asr")
    expect(resolveSourceModel("auto", undefined)).toBe("whisper")
    expect(resolveSourceModel("whisper", "zh")).toBe("whisper")
    expect(resolveSourceModel("omni-zs", "en")).toBe("whisper")
  })
})

describe("hostedRunSeconds", () => {
  it("is two requests at a time at 8 s each, then waits at every 60", () => {
    expect(hostedRunSeconds(0)).toBe(0)
    expect(hostedRunSeconds(1)).toBe(8)
    expect(hostedRunSeconds(60)).toBe(240)
    expect(hostedRunSeconds(61)).toBe(900 + 8)
  })
})
