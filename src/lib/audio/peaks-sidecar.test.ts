// The stored waveform that saves the recording. (AQU-2095)
//
// The sidecar's whole value is that it is tiny and that a bad one is harmless:
// a chapter of takes must draw from kilobytes, and anything this version
// cannot read has to fall back to decoding the clip rather than throw at a
// chip. Both properties are asserted here, along with the object name — get
// that wrong and every read misses while every write lands somewhere nothing
// looks, which is invisible until the bandwidth bill says otherwise.

import { describe, expect, it, vi, beforeEach } from "vitest"

// Desktop backend-reachability probe; null = unknown (web), the default.
let backendReachable: boolean | null = null
vi.mock("@/lib/offline/connectivity", () => ({ isOnline: async () => backendReachable }))

import { WAVEFORM_BINS } from "./peaks-loader"
import {
  PEAKS_SIDECAR_SUFFIX,
  decodePeaksSidecar,
  encodePeaksSidecar,
  fetchPeaksSidecar,
  peaksSidecarObjectName,
  putPeaksSidecar,
  publishPeaksSidecarOnce,
  __resetPeaksSidecarPublishesForTests,
} from "./peaks-sidecar"

const AUDIO_ID = "audio-cell1-1700000000-abcdefgh"
const EXT = "webm"
const base = {
  projectId: "p1",
  fileId: "f1",
  audioId: AUDIO_ID,
  ext: EXT,
  getSyncToken: async () => "tok",
}

function ramp(bins = WAVEFORM_BINS): Float32Array {
  return Float32Array.from({ length: bins }, (_, i) => i / (bins - 1))
}

beforeEach(() => {
  __resetPeaksSidecarPublishesForTests()
  backendReachable = null
})

describe("the object name", () => {
  it("is the clip's own name plus the suffix, so one key names both", () => {
    expect(peaksSidecarObjectName(AUDIO_ID, EXT)).toBe(`${AUDIO_ID}.${EXT}${PEAKS_SIDECAR_SUFFIX}`)
  })
})

describe("the stored body", () => {
  it("fits a chapter's worth of shapes in a few KB", () => {
    // The point of the ticket: 22 takes drew for ~400KB before this.
    const one = encodePeaksSidecar(ramp()).byteLength
    expect(one).toBeLessThan(400)
    expect(one * 22).toBeLessThan(10 * 1024)
  })

  it("round-trips a waveform within a quantization step", () => {
    const peaks = ramp()
    const back = decodePeaksSidecar(encodePeaksSidecar(peaks))
    expect(back).not.toBeNull()
    expect(back!.length).toBe(peaks.length)
    for (let i = 0; i < peaks.length; i++) {
      expect(Math.abs(back![i] - peaks[i])).toBeLessThanOrEqual(1 / 255)
    }
  })

  it("clamps what a decode can hand it — silence, overshoot and NaN", () => {
    const back = decodePeaksSidecar(encodePeaksSidecar(new Float32Array([0, 1, 2, -1, NaN])))
    expect(Array.from(back!)).toEqual([0, 1, 1, 0, 0])
  })

  it.each([
    ["an empty body", new Uint8Array()],
    ["somebody else's bytes", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
    ["a truncated body", encodePeaksSidecar(ramp()).slice(0, 100)],
  ])("reads %s as no sidecar at all, never as a flat take", (_label, bytes) => {
    expect(decodePeaksSidecar(bytes)).toBeNull()
  })

  it("refuses a version it does not know, rather than guessing at the layout", () => {
    const bytes = encodePeaksSidecar(ramp())
    bytes[4] = 99
    expect(decodePeaksSidecar(bytes)).toBeNull()
  })
})

describe("fetchPeaksSidecar", () => {
  it("reads the sidecar object under the clip's file, with the sync token", async () => {
    const fetchFn = vi.fn(async () => new Response(new Blob([encodePeaksSidecar(ramp())])))
    const peaks = await fetchPeaksSidecar({ ...base, fetchFn: fetchFn as unknown as typeof fetch })
    expect(peaks).toBeInstanceOf(Float32Array)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`/audio/p1/f1/${AUDIO_ID}.${EXT}${PEAKS_SIDECAR_SUFFIX}`)
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok")
  })

  it("is null when nothing has published one yet", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }))
    await expect(
      fetchPeaksSidecar({ ...base, fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBeNull()
  })

  it("is null, not a throw, when the request itself fails", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline") })
    await expect(
      fetchPeaksSidecar({ ...base, fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBeNull()
  })

  it("asks for nothing without a sync token", async () => {
    const fetchFn = vi.fn(async () => new Response(new Blob([encodePeaksSidecar(ramp())])))
    await expect(
      fetchPeaksSidecar({ ...base, getSyncToken: async () => null, fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // Ryder's Wi-Fi-off report, carried over from useCellAudio: with no backend
  // the waveform says "not available offline". Spending a request that cannot
  // succeed to get there is the bug, not the fallback.
  it("touches the network not at all when the backend is known unreachable", async () => {
    backendReachable = false
    const fetchFn = vi.fn(async () => new Response(new Blob([encodePeaksSidecar(ramp())])))
    await expect(
      fetchPeaksSidecar({ ...base, fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe("putPeaksSidecar", () => {
  it("PUTs the encoded body to the sidecar's own object", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(
      putPeaksSidecar({ ...base, peaks: ramp(), fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBe("stored")
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`${AUDIO_ID}.${EXT}${PEAKS_SIDECAR_SUFFIX}`)
    expect(init.method).toBe("PUT")
    expect(decodePeaksSidecar(new Uint8Array(init.body as ArrayBuffer))).toBeInstanceOf(Float32Array)
  })

  it("reports a refusal instead of throwing — a viewer may not write one", async () => {
    const fetchFn = vi.fn(async () => new Response("insufficient role", { status: 403 }))
    await expect(
      putPeaksSidecar({ ...base, peaks: ramp(), fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBe("refused")
  })

  it("skips rather than refuses when there is no backend to write to", async () => {
    backendReachable = false
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(
      putPeaksSidecar({ ...base, peaks: ramp(), fetchFn: fetchFn as unknown as typeof fetch }),
    ).resolves.toBe("skipped")
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe("publishPeaksSidecarOnce", () => {
  it("tries one clip once a session, however often it is drawn", async () => {
    const fetchFn = vi.fn(async () => new Response("insufficient role", { status: 403 }))
    const args = { ...base, peaks: ramp(), fetchFn: fetchFn as unknown as typeof fetch }
    await publishPeaksSidecarOnce(args)
    await publishPeaksSidecarOnce(args)
    await publishPeaksSidecarOnce(args)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("tries again later for a clip it never got to publish", async () => {
    // Offline is not a refusal: the shape is still worth storing once the tab
    // is back, or the next person to look at the take pays for the whole
    // recording again.
    backendReachable = false
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }))
    const args = { ...base, peaks: ramp(), fetchFn: fetchFn as unknown as typeof fetch }
    await publishPeaksSidecarOnce(args)
    expect(fetchFn).not.toHaveBeenCalled()

    backendReachable = null
    await publishPeaksSidecarOnce(args)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("still publishes a different clip", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }))
    const f = fetchFn as unknown as typeof fetch
    await publishPeaksSidecarOnce({ ...base, peaks: ramp(), fetchFn: f })
    await publishPeaksSidecarOnce({ ...base, audioId: "audio-cell2-1700000000-abcdefgh", peaks: ramp(), fetchFn: f })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
