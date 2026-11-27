import { describe, expect, it } from "vitest"
import {
  audioMinutes, estimateTranscriptionCost, hostedRunSeconds, resolveSourceModel, roundedDuration,
} from "./transcription-cost"

const min = (m: number, s = 0) => (m * 60 + s) * 1000

describe("estimateTranscriptionCost (AQU-2426, board 58)", () => {
  // Review, Nov 9: the windows are cut at a quiet moment in the last 5 s of
  // each minute, so they run 55 to 60 s and a recording takes a few more
  // requests than its minutes; and the words run sends one at a time.
  it("one 52-minute recording: about 55 requests, one at a time, about 7 minutes", () => {
    const cost = estimateTranscriptionCost({ durationsMs: [min(52, 14)], chosenModel: "auto", languageTag: "en", onDevice: false })
    expect(cost.requests).toBe(55)
    expect(cost.model).toBe("whisper")
    expect(cost.automatic).toBe(true)
    expect(cost.waitsAtLimit).toBe(false)
    expect(roundedDuration(cost.seconds)).toEqual({ minutes: 7 })
    expect(audioMinutes(cost.audioMs)).toBe(52)
  })

  it("never shows fewer requests than the run can send", () => {
    for (const sec of [61, 119, 600, 3134, 5400]) {
      const cost = estimateTranscriptionCost({ durationsMs: [sec * 1000], chosenModel: "whisper", onDevice: false })
      // The fewest the cutter can make: every window a full minute.
      expect(cost.requests).toBeGreaterThanOrEqual(Math.ceil(sec / 60))
      // And no more than every window at its shortest.
      expect(cost.requests).toBeLessThanOrEqual(Math.ceil(sec / 55))
    }
  })

  it("a recording that fits one window is one request", () => {
    expect(estimateTranscriptionCost({ durationsMs: [58_000], chosenModel: "whisper", onDevice: false }).requests).toBe(1)
    expect(estimateTranscriptionCost({ durationsMs: [60_000], chosenModel: "whisper", onDevice: false }).requests).toBe(1)
  })

  it("three recordings together: about 106 requests, past the limit, about 20 minutes", () => {
    const cost = estimateTranscriptionCost({
      durationsMs: [min(52, 14), min(47, 26), min(0, 40)], chosenModel: "auto", languageTag: "en", onDevice: false,
    })
    expect(cost.requests).toBe(106)
    expect(cost.recordings).toBe(3)
    expect(cost.waitsAtLimit).toBe(true)
    expect(roundedDuration(cost.seconds)).toEqual({ minutes: 20 })
  })

  it("Omnilingual takes 30 seconds a request, so two for each minute", () => {
    const cost = estimateTranscriptionCost({ durationsMs: [min(10)], chosenModel: "omni-ctc", onDevice: false })
    expect(cost.windowSec).toBe(30)
    expect(cost.requests).toBe(22)
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
  it("is one request at a time at 8 s each (as the words run sends them), then waits at every 60", () => {
    expect(hostedRunSeconds(0)).toBe(0)
    expect(hostedRunSeconds(1)).toBe(8)
    expect(hostedRunSeconds(60)).toBe(480)
    expect(hostedRunSeconds(61)).toBe(900 + 8)
  })
})
