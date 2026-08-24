import { describe, it, expect } from "vitest"
import { MAX_AUDIO_UPLOAD_BYTES } from "./upload"
import {
  recordingLimitsFor,
  WAV_BYTES_PER_SEC,
  WAV_HEADER_BYTES,
  WAV_SAMPLE_RATE,
} from "./recording-limits"

const MINUTE = 60 * 1000

function wavBytesFor(hardStopMs: number): number {
  return (hardStopMs / 1000) * WAV_BYTES_PER_SEC + WAV_HEADER_BYTES
}

describe("recordingLimitsFor", () => {
  // The invariant the whole size design rests on. Asserted rather than left to
  // a comment, because the failure mode is a take the operator has already
  // performed being rejected at upload.
  it("keeps a full-length wav take inside the upload cap", () => {
    const { hardStopMs, maxFrames } = recordingLimitsFor("wav")
    expect(wavBytesFor(hardStopMs)).toBeLessThan(MAX_AUDIO_UPLOAD_BYTES)
    expect(maxFrames).toBe((hardStopMs / 1000) * WAV_SAMPLE_RATE)
  })

  it("leaves the webm limits exactly where they were", () => {
    // Opting out of WAV must change nothing else about the recorder.
    expect(recordingLimitsFor("webm")).toMatchObject({
      warnMs: 25 * MINUTE,
      hardStopMs: 30 * MINUTE,
    })
  })

  it("shortens both formats when the caller caps the bytes", () => {
    const maxBytes = 8 * 1024 * 1024 // the voice-clone reference budget
    const wav = recordingLimitsFor("wav", { maxBytes })
    const webm = recordingLimitsFor("webm", { maxBytes })

    expect(wav.hardStopMs).toBeLessThan(15 * MINUTE)
    expect(webm.hardStopMs).toBeLessThan(30 * MINUTE)
    expect(wavBytesFor(wav.hardStopMs)).toBeLessThan(maxBytes)
    // A tighter window must still warn before it stops, not at the same moment.
    expect(wav.warnMs).toBeLessThan(wav.hardStopMs)
    expect(webm.warnMs).toBeLessThan(webm.hardStopMs)
  })
})
