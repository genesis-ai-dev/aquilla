// AQU-2664 (Sam, Nov 19): a long import is measured section by section within
// the memory budget, never decoded whole: only the MP3 frames around the
// section are decoded (the AQU-1857 frame walk).
import { describe, expect, it, vi } from "vitest"
import { decodeMp3Window } from "./mp3-window"
import { buildMp3Fixture, FIXTURE_FRAME_BYTES, FIXTURE_SAMPLES_PER_FRAME, FIXTURE_SAMPLE_RATE } from "./__fixtures__/mp3-stream"
import { TARGET_RATE } from "./decode-mono"

const PER_FRAME_48K = (FIXTURE_SAMPLES_PER_FRAME * TARGET_RATE) / FIXTURE_SAMPLE_RATE

/** A stub decoder: each frame becomes its own ordinal, held for the frame. */
function stubDecode(bytes: Uint8Array): Promise<Float32Array> {
  const frames = Math.floor(bytes.length / FIXTURE_FRAME_BYTES)
  const out = new Float32Array(frames * PER_FRAME_48K)
  for (let f = 0; f < frames; f++) {
    const at = f * FIXTURE_FRAME_BYTES
    const ordinal = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16)
    out.fill(ordinal, f * PER_FRAME_48K, (f + 1) * PER_FRAME_48K)
  }
  return Promise.resolve(out)
}

describe("decoding a part of a long MP3", () => {
  const frames = 3000 // 108 s at 36 ms a frame
  const mp3 = buildMp3Fixture(frames)

  it("returns exactly the section, decoding only the chunks around it", async () => {
    const decode = vi.fn(stubDecode)
    const pcm = await decodeMp3Window(mp3, 42, 43, { decode, chunkSec: 10 })
    expect(pcm).not.toBeNull()
    expect(pcm!.length).toBe(TARGET_RATE)
    const frameAt = (sec: number) => Math.floor((sec * FIXTURE_SAMPLE_RATE) / FIXTURE_SAMPLES_PER_FRAME)
    expect(pcm![0]).toBe(frameAt(42))
    expect(pcm![pcm!.length - 1]).toBe(frameAt(43 - 1 / TARGET_RATE))
    // One ~10 s chunk holds 42–43 s: 1 of 11 decoded.
    expect(decode).toHaveBeenCalledTimes(1)
    const total = decode.mock.calls.reduce((n, [b]) => n + b.length, 0)
    expect(total).toBeLessThan(mp3.length / 5)
  })

  it("joins a section that crosses a chunk edge", async () => {
    const pcm = await decodeMp3Window(mp3, 9.5, 10.5, { decode: stubDecode, chunkSec: 10 })
    expect(pcm!.length).toBe(TARGET_RATE)
    const frameAt = (sec: number) => Math.floor((sec * FIXTURE_SAMPLE_RATE) / FIXTURE_SAMPLES_PER_FRAME)
    expect(pcm![0]).toBe(frameAt(9.5))
    expect(pcm![TARGET_RATE / 2 + 10]).toBe(frameAt(10.0 + 10 / TARGET_RATE))
  })

  it("is null for audio that isn't MP3", async () => {
    expect(await decodeMp3Window(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), 0, 1, { decode: stubDecode })).toBeNull()
  })

})
