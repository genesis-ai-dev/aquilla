import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  analyseMp3Chunks,
  analyseSpeechInFile,
  ANALYSIS_SAMPLE_RATE,
  estimateDecodedBytes,
  type AudioDecodeFn,
  type DecodedPcm,
} from "./speech-analysis"
import { blobRangeReader, planMp3Chunks } from "./mp3-chunks"
import { detectSpeechSegments } from "../timeline/silence-split"
import {
  buildMp3Fixture,
  FIXTURE_SAMPLES_PER_FRAME,
  FIXTURE_SAMPLE_RATE,
  fixtureFrameOrdinal,
} from "./__fixtures__/mp3-stream"

// WHY: AQU-1857. A 100-minute MP3 used to become one ~2.3 GB PCM allocation
// and crash the tab. The fix decodes long recordings a chunk at a time, which
// only helps if the chunked answer is the SAME answer — so the first block
// runs the real chunk planner's output through the real folding path and
// compares it to the whole-array detector, and the rest pins which route each
// file takes (short files must still take the untouched whole-file decode).

const FRAMES = 120
/** The fixture is 16 kHz, which is also the analysis rate, so chunk sample
 *  counts convert 1:1 and the comparison can be exact rather than fuzzy. */
const TOTAL_SAMPLES = FRAMES * FIXTURE_SAMPLES_PER_FRAME

/** Mono signal: a 220 Hz tone inside each burst, digital silence outside. */
function buildSignal(totalSamples: number, bursts: ReadonlyArray<[number, number]>): Float32Array {
  const out = new Float32Array(totalSamples)
  for (const [startSec, endSec] of bursts) {
    const from = Math.round(startSec * ANALYSIS_SAMPLE_RATE)
    const to = Math.min(totalSamples, Math.round(endSec * ANALYSIS_SAMPLE_RATE))
    for (let i = from; i < to; i++) {
      out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * (i - from)) / ANALYSIS_SAMPLE_RATE)
    }
  }
  return out
}

const reference = buildSignal(TOTAL_SAMPLES, [[0, 1.2], [1.8, 3.1], [3.7, 4.3]])

/**
 * Stand-in decoder: reads the ordinal the fixture wrote into each frame and
 * returns that byte range's slice of `reference` — what a real decoder would
 * produce, minus the codec. `jitter` models a decoder that hands back a few
 * samples more or fewer than the frame headers declare (encoder delay).
 */
function fixtureDecoder(jitter = 0): AudioDecodeFn & { calls: Array<number | undefined> } {
  const calls: Array<number | undefined> = []
  const decode = async (bytes: ArrayBuffer, sampleRate?: number): Promise<DecodedPcm> => {
    calls.push(sampleRate)
    const view = new Uint8Array(bytes)
    const ordinal = fixtureFrameOrdinal(view)
    const frames = view.length / 288
    const from = ordinal * FIXTURE_SAMPLES_PER_FRAME
    const declared = frames * FIXTURE_SAMPLES_PER_FRAME
    const length = Math.max(0, Math.min(declared + jitter, TOTAL_SAMPLES - from))
    return {
      channel: reference.slice(from, from + length),
      sampleRate: ANALYSIS_SAMPLE_RATE,
      durationMs: (length / ANALYSIS_SAMPLE_RATE) * 1000,
    }
  }
  return Object.assign(decode, { calls })
}

function mp3File(bytes: Uint8Array<ArrayBuffer>, name = "sermon.mp3"): File {
  return new File([bytes], name, { type: "audio/mpeg" })
}

describe("analyseMp3Chunks", () => {
  const bytes = buildMp3Fixture(FRAMES)
  const file = mp3File(bytes)
  const whole = detectSpeechSegments(reference, ANALYSIS_SAMPLE_RATE)

  async function planFor(chunkMs: number) {
    const plan = await planMp3Chunks(blobRangeReader(file), file.size, chunkMs)
    expect(plan).not.toBeNull()
    return plan!
  }

  it("the whole signal in one chunk reproduces the whole-array segments", async () => {
    const result = await analyseMp3Chunks(file, await planFor(60_000), fixtureDecoder())
    expect(result!.segments).toEqual(whole)
  })

  it("segments are identical however the recording is chunked", async () => {
    expect(whole.length).toBeGreaterThan(1) // the comparison is only meaningful if it split
    for (const chunkMs of [40, 100, 250, 1000, 2000]) {
      const result = await analyseMp3Chunks(file, await planFor(chunkMs), fixtureDecoder())
      expect(result!.segments, `chunked at ${chunkMs}ms`).toEqual(whole)
    }
  })

  it("duration comes from the frame headers, not the decoder's output length", async () => {
    const result = await analyseMp3Chunks(file, await planFor(100), fixtureDecoder(512))
    expect(result!.durationMs).toBeCloseTo((TOTAL_SAMPLES / FIXTURE_SAMPLE_RATE) * 1000, 6)
  })

  it("trims a decoder that over-delivers, so boundaries cannot drift across chunks", async () => {
    // Untrimmed, 30 chunks x 200 extra samples would slide the tail by ~375 ms.
    const result = await analyseMp3Chunks(file, await planFor(100), fixtureDecoder(200))
    expect(result!.segments).toEqual(whole)
  })

  it("pads a decoder that under-delivers rather than compacting the timeline", async () => {
    const result = await analyseMp3Chunks(file, await planFor(100), fixtureDecoder(-80))
    expect(result!.segments).toHaveLength(whole.length)
    for (const [i, segment] of result!.segments.entries()) {
      expect(Math.abs(segment.startMs - whole[i].startMs)).toBeLessThanOrEqual(20)
      expect(Math.abs(segment.endMs - whole[i].endMs)).toBeLessThanOrEqual(20)
    }
  })

  it("decodes at the analysis rate, one chunk at a time", async () => {
    const decode = fixtureDecoder()
    const plan = await planFor(100)
    await analyseMp3Chunks(file, plan, decode)
    expect(decode.calls).toHaveLength(plan.chunks.length)
    expect(new Set(decode.calls)).toEqual(new Set([ANALYSIS_SAMPLE_RATE]))
  })

  it("yields to the event loop between chunks", async () => {
    const yieldToEventLoop = vi.fn(async () => {})
    const plan = await planFor(100)
    await analyseMp3Chunks(file, plan, fixtureDecoder(), yieldToEventLoop)
    expect(yieldToEventLoop).toHaveBeenCalledTimes(plan.chunks.length)
  })

  it("gives up (null) when a chunk fails to decode, rather than reporting half a recording", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const flaky: AudioDecodeFn = async (bytes, rate) => {
      const ordinal = fixtureFrameOrdinal(new Uint8Array(bytes))
      if (ordinal > 0) throw new Error("EncodingError")
      return fixtureDecoder()(bytes, rate)
    }
    expect(await analyseMp3Chunks(file, await planFor(100), flaky)).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("analyseSpeechInFile", () => {
  const bytes = buildMp3Fixture(FRAMES)
  const fixtureDurationMs = (TOTAL_SAMPLES / FIXTURE_SAMPLE_RATE) * 1000
  /** Between the fixture's estimate at 48 kHz (~1.66 MB) and at 16 kHz
   *  (~553 kB), so "over budget whole, within budget reduced" is reachable
   *  without a gigabyte-scale fixture. */
  const SPLIT_BUDGET_BYTES = 1_000_000
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it("returns null when the platform cannot decode audio at all", async () => {
    // happy-dom has no AudioContext, and no decoder is injected.
    expect(await analyseSpeechInFile(mp3File(bytes))).toBeNull()
  })

  it("decodes a short file whole, at the platform's own rate", async () => {
    const decode = fixtureDecoder()
    const result = await analyseSpeechInFile(mp3File(bytes), {
      decode,
      probeDurationMs: async () => fixtureDurationMs,
    })
    expect(decode.calls).toEqual([undefined])
    expect(result!.segments).toEqual(detectSpeechSegments(reference, ANALYSIS_SAMPLE_RATE))
  })

  it("streams an over-budget MP3 in chunks instead of decoding it whole", async () => {
    const decode = fixtureDecoder()
    const result = await analyseSpeechInFile(mp3File(bytes), {
      decode,
      probeDurationMs: async () => fixtureDurationMs,
      limits: { pcmBudgetBytes: SPLIT_BUDGET_BYTES, chunkMs: 100 },
    })
    expect(decode.calls.length).toBeGreaterThan(1)
    expect(decode.calls).not.toContain(undefined)
    expect(result!.segments).toEqual(detectSpeechSegments(reference, ANALYSIS_SAMPLE_RATE))
  })

  it("decodes an over-budget non-MP3 whole at the reduced analysis rate", async () => {
    const decode = fixtureDecoder()
    const result = await analyseSpeechInFile(
      new File([bytes], "lecture.m4a", { type: "audio/mp4" }),
      {
        decode,
        probeDurationMs: async () => fixtureDurationMs,
        limits: { pcmBudgetBytes: SPLIT_BUDGET_BYTES, chunkMs: 100 },
      },
    )
    expect(decode.calls).toEqual([ANALYSIS_SAMPLE_RATE])
    expect(result!.segments.length).toBeGreaterThan(0)
  })

  it("imports as one segment, with the real duration, when no route fits the budget", async () => {
    const hundredMinutesMs = 100 * 60 * 1000
    const decode = fixtureDecoder()
    const result = await analyseSpeechInFile(
      new File([bytes], "lecture.m4a", { type: "audio/mp4" }),
      { decode, probeDurationMs: async () => hundredMinutesMs },
    )
    expect(result).toEqual({ segments: [], durationMs: hundredMinutesMs })
    expect(decode.calls).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it("declines the chunked route when the frame walk does not cover the recording", async () => {
    // A plan that accounts for 4.3 s of a file the probe says is 10 minutes is
    // a walk that stopped early; analysing it would silently drop the tail.
    const decode = fixtureDecoder()
    const result = await analyseSpeechInFile(mp3File(bytes), {
      decode,
      probeDurationMs: async () => 10 * 60 * 1000,
      limits: { pcmBudgetBytes: SPLIT_BUDGET_BYTES },
    })
    expect(result).toEqual({ segments: [], durationMs: 10 * 60 * 1000 })
  })

  it("decodes whole when the duration probe fails but the file is small", async () => {
    const decode = fixtureDecoder()
    const result = await analyseSpeechInFile(mp3File(bytes), {
      decode,
      probeDurationMs: async () => undefined,
    })
    expect(decode.calls).toEqual([undefined])
    expect(result!.segments.length).toBeGreaterThan(0)
  })

  it("rewraps an undecodable file's cryptic DOMException", async () => {
    const decode: AudioDecodeFn = async () => {
      throw new DOMException("Decoding failed", "EncodingError")
    }
    await expect(
      analyseSpeechInFile(mp3File(bytes, "broken.mp3"), { decode, probeDurationMs: async () => 1000 }),
    ).rejects.toThrow(/broken\.mp3/)
  })
})

describe("estimateDecodedBytes", () => {
  it("sizes a 100-minute recording at 48 kHz stereo in the gigabytes", () => {
    expect(estimateDecodedBytes(100 * 60 * 1000, 48_000)).toBeCloseTo(2_304_000_000, 0)
  })

  it("is zero for a zero-length recording", () => {
    expect(estimateDecodedBytes(0, 48_000)).toBe(0)
  })
})
