import { afterEach, describe, expect, it, vi } from "vitest"
import { synthesizeCellTts } from "./tts"
import { TTS_REQUEST_TIMEOUT_MS } from "@/lib/audio/tts-engine-error"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const getSyncToken = async () => "sync-token"

const args = {
  projectId: "p1",
  fileId: "f1",
  cellId: "c1",
  text: "In the beginning",
}

const okBody = {
  audioId: "audio-tts-1-ab12cd34",
  durationSeconds: 1.5,
  objectName: "audio-tts-1-ab12cd34.wav",
  url: "frontier-audio://audio-tts-1-ab12cd34.wav",
}

/** The DOMException shape `AbortSignal.timeout` rejects a fetch with. */
function timeoutRejection(): Error {
  const err = new Error("The operation was aborted due to timeout")
  err.name = "TimeoutError"
  return err
}

describe("synthesizeCellTts — AQU-1156 request deadline", () => {
  it("bounds the request with an abort signal", async () => {
    let init: RequestInit | undefined
    vi.stubGlobal("fetch", vi.fn(async (_url: string, requestInit?: RequestInit) => {
      init = requestInit
      return new Response(JSON.stringify(okBody), { status: 200 })
    }))

    await expect(synthesizeCellTts(args, getSyncToken)).resolves.toEqual(okBody)

    // The shared older-WebKit guard returns undefined where AbortSignal.timeout
    // is missing; under vitest it exists, so a real signal must be attached.
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)
  })

  it("turns a blown deadline into a named, retryable error rather than hanging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutRejection() }))

    await expect(synthesizeCellTts(args, getSyncToken)).rejects.toThrow(
      `Inworld TTS did not respond within ${TTS_REQUEST_TIMEOUT_MS / 1000}s`,
    )
    // Names the engine (never reads as a missing Gemini key) and says a retry
    // is available, because the control is idle again once this throws.
    await expect(synthesizeCellTts(args, getSyncToken)).rejects.toThrow(/click generate again/i)
  })

  it("leaves non-timeout network failures alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))

    await expect(synthesizeCellTts(args, getSyncToken)).rejects.toThrow("Failed to fetch")
  })

  it("still maps a non-OK response through errorFromHostedTts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Inworld TTS did not respond within 60s", { status: 502 })),
    )

    await expect(synthesizeCellTts(args, getSyncToken)).rejects.toThrow(
      "Inworld TTS failed (502): Inworld TTS did not respond within 60s",
    )
  })
})
