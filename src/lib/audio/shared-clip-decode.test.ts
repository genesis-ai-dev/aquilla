import { describe, it, expect, vi, afterEach } from "vitest"
import { decodeSharedClipPcm, decodeLongMp3To16kMono, type ChunkDecodeFn } from "./shared-clip-decode"
import {
  buildMp3Fixture,
  fixtureFrameOrdinal,
  FIXTURE_FRAME_BYTES,
  FIXTURE_SAMPLES_PER_FRAME,
} from "./__fixtures__/mp3-stream"

// WHY: AQU-1681 made a batch decode a shared recording once instead of once
// per row; AQU-1886 is the decode that was left — one `decodeAudioData` over
// the whole file, which holds two whole-clip allocations while the mono copy
// is taken and which some browsers refuse to carry to the end of a
// feature-length recording. A long MPEG clip is therefore decoded a minute at
// a time into one buffer.
//
// What these pin is the part that can be wrong without anyone noticing: every
// chunk lands at the offset its FRAME HEADERS put it at, so a decoder that
// drops or adds samples at a chunk edge cannot slide every later row's trim
// window off the audio it names — and that the routes which must stay on the
// untouched whole-file decode (short clips, non-MPEG bytes, a chunk the
// decoder refuses) do.

/** The fixture is 16 kHz, so a chunk of `n` frames owes `n * 576` samples. */
const FRAME_MS = (FIXTURE_SAMPLES_PER_FRAME / 16_000) * 1000 // 36 ms
/** Ten frames per chunk — the fixture's stand-in for a minute. */
const CHUNK_MS = FRAME_MS * 10
const FRAMES_PER_CHUNK = 10

/** Long enough to take the chunked route at this test's threshold. */
const LONG_ENOUGH_MS = FRAME_MS

const chunked = { chunkMs: CHUNK_MS, minChunkedMs: LONG_ENOUGH_MS }

/** Every sample of the reference signal is its own index from the start of the
 *  recording, so a misplaced chunk shows up as the wrong number. */
function referenceSignal(frames: number): Float32Array {
  const out = new Float32Array(frames * FIXTURE_SAMPLES_PER_FRAME)
  for (let i = 0; i < out.length; i++) out[i] = i
  return out
}

/**
 * A decoder with no codec in it: the fixture's frames carry their ordinals, so
 * a byte range knows exactly which part of {@link referenceSignal} it covers.
 * `distort` can make a chunk decode short or long, as a real decoder does at a
 * chunk edge.
 */
function stubDecoder(
  distort: (chunkIndex: number, samples: number) => number = (_, samples) => samples,
): { decodeChunk: ChunkDecodeFn; sawFrames: number[] } {
  const sawFrames: number[] = []
  let call = 0
  const decodeChunk: ChunkDecodeFn = async (bytes) => {
    const frames = bytes.byteLength / FIXTURE_FRAME_BYTES
    sawFrames.push(frames)
    const first = fixtureFrameOrdinal(bytes) * FIXTURE_SAMPLES_PER_FRAME
    const length = Math.max(0, distort(call++, frames * FIXTURE_SAMPLES_PER_FRAME))
    const out = new Float32Array(length)
    for (let i = 0; i < length; i++) out[i] = first + i
    return out
  }
  return { decodeChunk, sawFrames }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("decodeLongMp3To16kMono", () => {
  it("assembles a long clip chunk by chunk, decoding at most one chunk of audio at a time", async () => {
    const frames = FRAMES_PER_CHUNK * 3 + 4
    const { decodeChunk, sawFrames } = stubDecoder()

    const pcm = await decodeLongMp3To16kMono(buildMp3Fixture(frames), { ...chunked, decodeChunk })

    expect(pcm).toEqual(referenceSignal(frames))
    // Four chunks, none bigger than the step — never the whole recording.
    expect(sawFrames).toEqual([FRAMES_PER_CHUNK, FRAMES_PER_CHUNK, FRAMES_PER_CHUNK, 4])
  })

  it.each([
    { name: "decodes short (encoder delay at a chunk edge)", distort: (i: number, n: number) => (i === 1 ? n - 100 : n) },
    { name: "decodes long (padding at a chunk edge)", distort: (i: number, n: number) => (i === 1 ? n + 100 : n) },
  ])("keeps every later chunk on the frame headers' clock when a chunk $name", async ({ distort }) => {
    const frames = FRAMES_PER_CHUNK * 3
    const { decodeChunk } = stubDecoder(distort)

    const pcm = await decodeLongMp3To16kMono(buildMp3Fixture(frames), { ...chunked, decodeChunk })

    const chunkSamples = FRAMES_PER_CHUNK * FIXTURE_SAMPLES_PER_FRAME
    expect(pcm).toHaveLength(frames * FIXTURE_SAMPLES_PER_FRAME)
    // The distorted chunk is cut, or left as silence, at its own boundary…
    expect(pcm![chunkSamples]).toBe(chunkSamples)
    // …and the chunk after it still starts exactly where its frames say.
    expect(pcm![chunkSamples * 2]).toBe(chunkSamples * 2)
    expect(pcm![pcm!.length - 1]).toBe(pcm!.length - 1)
  })

  it("leaves silence for the samples a short chunk owed rather than pulling the tail forward", async () => {
    const { decodeChunk } = stubDecoder((i, n) => (i === 0 ? n - 100 : n))

    const pcm = await decodeLongMp3To16kMono(buildMp3Fixture(FRAMES_PER_CHUNK * 2), { ...chunked, decodeChunk })

    const chunkSamples = FRAMES_PER_CHUNK * FIXTURE_SAMPLES_PER_FRAME
    expect(pcm![chunkSamples - 101]).toBe(chunkSamples - 101)
    expect(pcm![chunkSamples - 1]).toBe(0)
    expect(pcm![chunkSamples]).toBe(chunkSamples)
  })

  it.each([
    { name: "a clip shorter than the threshold", bytes: () => buildMp3Fixture(5), deps: {} },
    { name: "bytes that are not a frame-walkable MPEG stream", bytes: () => new Uint8Array(4096), deps: chunked },
  ])("declines $name", async ({ bytes, deps }) => {
    const { decodeChunk, sawFrames } = stubDecoder()

    expect(await decodeLongMp3To16kMono(bytes(), { ...deps, decodeChunk })).toBeNull()
    expect(sawFrames).toEqual([])
  })
})

describe("decodeSharedClipPcm", () => {
  it("decodes the clip whole when the chunked route declines", async () => {
    const whole = new Float32Array([1, 2, 3])
    const decodeWhole = vi.fn(async () => whole)
    const { decodeChunk } = stubDecoder()

    // Short enough that the chunked route is not even attempted.
    const pcm = await decodeSharedClipPcm(buildMp3Fixture(5), decodeWhole, { decodeChunk })

    expect(pcm).toBe(whole)
    expect(decodeWhole).toHaveBeenCalledOnce()
  })

  it("falls back to the whole-clip decode when a chunk cannot be decoded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const whole = new Float32Array([4, 5, 6])
    const decodeWhole = vi.fn(async () => whole)
    let call = 0
    const decodeChunk: ChunkDecodeFn = async () => {
      if (call++ === 1) throw new Error("EncodingError")
      return new Float32Array(FRAMES_PER_CHUNK * FIXTURE_SAMPLES_PER_FRAME)
    }

    const pcm = await decodeSharedClipPcm(buildMp3Fixture(FRAMES_PER_CHUNK * 3), decodeWhole, {
      ...chunked,
      decodeChunk,
    })

    expect(pcm).toBe(whole)
    expect(decodeWhole).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
  })

  it("uses the chunked PCM when the route applies, without a whole-clip decode", async () => {
    const decodeWhole = vi.fn(async () => new Float32Array(0))
    const { decodeChunk } = stubDecoder()
    const frames = FRAMES_PER_CHUNK * 2

    const pcm = await decodeSharedClipPcm(buildMp3Fixture(frames), decodeWhole, { ...chunked, decodeChunk })

    expect(pcm).toEqual(referenceSignal(frames))
    expect(decodeWhole).not.toHaveBeenCalled()
  })
})
