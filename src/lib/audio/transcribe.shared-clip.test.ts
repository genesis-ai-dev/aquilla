import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// AQU-1681. WHY: the end-to-end half of shared-clip-pcm.test.ts. A batch over
// the rows of one long recording must decode that recording ONCE through the
// real transcription entry point, and every row must still get exactly its
// own window — the window a per-row decode would have produced.

const hostedWindows = vi.hoisted(() => [] as number[][])
vi.mock("./transcribe-hosted", () => ({
  transcribeHosted: vi.fn(async (pcm: Float32Array) => {
    hostedWindows.push([pcm.length, pcm[0] ?? -1])
    return { text: "ok", chunks: [] }
  }),
}))

// transcribe.ts reads the AudioContext constructor when it loads, so the
// stand-in goes in first: a 16 kHz context whose decode is a 10-second ramp
// (sample i = i), counted.
const decoder = vi.hoisted(() => {
  const state = { calls: 0 }
  class FakeContext {
    async decodeAudioData() {
      state.calls += 1
      const data = Float32Array.from({ length: 160_000 }, (_, i) => i)
      return {
        sampleRate: 16_000,
        length: data.length,
        numberOfChannels: 1,
        copyFromChannel: (dest: Float32Array, _ch: number, start: number) =>
          dest.set(data.subarray(start, start + dest.length)),
      }
    }
    async close() {}
  }
  ;(window as unknown as { AudioContext: unknown }).AudioContext = FakeContext
  return state
})

import { transcribeAudio } from "./transcribe"
import { releaseSharedClipPcm } from "./shared-clip-pcm"
import type { FrontierSession } from "@/lib/frontier/types"

const session: FrontierSession = { jwt: "jwt", username: "maint", createdAt: "2026-01-01T00:00:00Z" }

beforeEach(() => {
  hostedWindows.length = 0
  decoder.calls = 0
})
afterEach(() => releaseSharedClipPcm())

describe("transcribeAudio over a shared clip", () => {
  it("decodes the clip once and gives each row its own window", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const opts = { session, projectId: "p1", sharedClipKey: "clip.m4a" }
    await transcribeAudio(bytes, { ...opts, trim: { trimStartMs: 1000, trimEndMs: 2000 } })
    await transcribeAudio(new Uint8Array(0), {
      ...opts,
      trim: { trimStartMs: 7000, trimEndMs: 7500 },
      loadClipBytes: async () => { throw new Error("the held clip must be used") },
    })
    expect(decoder.calls).toBe(1)
    expect(hostedWindows).toEqual([[16_000, 16_000], [8_000, 112_000]])
  })

  it("still decodes per row without a shared key (a take)", async () => {
    await transcribeAudio(new Uint8Array([1]), { session, projectId: "p1", trim: { trimStartMs: 0, trimEndMs: 1000 } })
    await transcribeAudio(new Uint8Array([1]), { session, projectId: "p1", trim: { trimStartMs: 0, trimEndMs: 1000 } })
    expect(decoder.calls).toBe(2)
  })
})
