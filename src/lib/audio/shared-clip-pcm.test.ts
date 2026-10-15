import { afterEach, describe, expect, it, vi } from "vitest"

import {
  hasSharedClipPcm,
  releaseSharedClipPcm,
  sharedClipWindow,
  SHARED_CLIP_IDLE_MS,
} from "./shared-clip-pcm"

// AQU-1681. WHY: every row of an imported recording (and of a linked video's
// own sound) transcribes a window of ONE shared clip. Each row used to decode
// the whole clip for itself — for a 55-minute episode cut into ~800 rows,
// about 45 minutes of decoding and a 420 MB buffer per row. A batch must
// decode the clip once and cut each row's window from that, hand each row a
// buffer of its own (the Whisper hand-off detaches what it is given), and let
// the memory go once the batch is done.

/** 16 kHz "PCM" whose every sample is its own index, so a window is checkable. */
function rampDecoder(seconds: number) {
  return vi.fn(async () => Float32Array.from({ length: seconds * 16_000 }, (_, i) => i))
}

afterEach(() => {
  releaseSharedClipPcm()
  vi.useRealTimers()
})

describe("sharedClipWindow", () => {
  it("decodes a clip once for every row's window", async () => {
    const decode = rampDecoder(10)
    const load = vi.fn(() => new Uint8Array([1]))
    const [a, b] = await Promise.all([
      sharedClipWindow("clip.m4a", { trimStartMs: 1000, trimEndMs: 2000 }, load, decode),
      sharedClipWindow("clip.m4a", { trimStartMs: 5000, trimEndMs: 5500 }, load, decode),
    ])
    const c = await sharedClipWindow("clip.m4a", { trimStartMs: 9000, trimEndMs: null }, load, decode)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect([a.length, a[0]]).toEqual([16_000, 16_000])
    expect([b.length, b[0]]).toEqual([8_000, 80_000])
    expect([c.length, c[0]]).toEqual([16_000, 144_000])
  })

  it("hands each row its own buffer, so transferring one cannot empty the clip", async () => {
    const decode = rampDecoder(4)
    const first = await sharedClipWindow("clip.m4a", { trimStartMs: 0, trimEndMs: 4000 }, () => new Uint8Array(), decode)
    structuredClone(first.buffer, { transfer: [first.buffer] })
    const again = await sharedClipWindow("clip.m4a", { trimStartMs: 0, trimEndMs: 1000 }, () => new Uint8Array(), decode)
    expect(again.length).toBe(16_000)
  })

  it("decodes again for a different clip, and does not keep a failed decode", async () => {
    const decode = rampDecoder(2)
    await sharedClipWindow("a.m4a", { trimStartMs: 0, trimEndMs: 500 }, () => new Uint8Array(), decode)
    await sharedClipWindow("b.m4a", { trimStartMs: 0, trimEndMs: 500 }, () => new Uint8Array(), decode)
    expect(decode).toHaveBeenCalledTimes(2)
    expect(hasSharedClipPcm("a.m4a")).toBe(false)

    const broken = vi.fn(async () => { throw new Error("EncodingError") })
    await expect(sharedClipWindow("c.m4a", { trimStartMs: 0, trimEndMs: 1 }, () => new Uint8Array(), broken))
      .rejects.toThrow("EncodingError")
    expect(hasSharedClipPcm("c.m4a")).toBe(false)
  })

  it("lets the clip go a minute after its last row", async () => {
    vi.useFakeTimers()
    await sharedClipWindow("clip.m4a", { trimStartMs: 0, trimEndMs: 500 }, () => new Uint8Array(), rampDecoder(1))
    expect(hasSharedClipPcm("clip.m4a")).toBe(true)
    vi.advanceTimersByTime(SHARED_CLIP_IDLE_MS - 1)
    expect(hasSharedClipPcm("clip.m4a")).toBe(true)
    vi.advanceTimersByTime(1)
    expect(hasSharedClipPcm("clip.m4a")).toBe(false)
  })
})
