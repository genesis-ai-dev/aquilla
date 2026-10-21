// The ladder that finds a clip's peaks, and above all THE TWO CACHE KEYS.
//
// Peaks are keyed on the attachment key ("<audioId>.<ext>"); bytes on the
// parsed (audioId, ext) pair. Swapping them breaks nothing visibly — it just
// means every lookup misses, the cache the Recording tab has been filling is
// never read, and every chip re-decodes from the network. So the key each
// cache is called with is asserted directly rather than inferred from a hit.

import { describe, expect, it, vi, beforeEach } from "vitest"

const peaksCacheGet = vi.fn<(audioId: string, bins: number) => Promise<Float32Array | null>>()
const peaksCachePut = vi.fn<(audioId: string, peaks: Float32Array) => Promise<void>>()
vi.mock("./peaks-cache", () => ({
  peaksCacheGet: (...a: [string, number]) => peaksCacheGet(...a),
  peaksCachePut: (...a: [string, Float32Array]) => peaksCachePut(...a),
}))

const audioCacheGet = vi.fn<(audioId: string, ext: string) => Promise<Uint8Array | null>>()
const audioCachePut = vi.fn<(audioId: string, ext: string, b: Uint8Array) => Promise<void>>()
vi.mock("./bytes-cache", () => ({
  audioCacheGet: (...a: [string, string]) => audioCacheGet(...a),
  audioCachePut: (...a: [string, string, Uint8Array]) => audioCachePut(...a),
}))

const fetchCellAudio = vi.fn<(args: Record<string, unknown>) => Promise<Uint8Array>>()
vi.mock("./upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload")>()
  return { ...actual, fetchCellAudio: (a: Record<string, unknown>) => fetchCellAudio(a) }
})

const decodePeaks = vi.fn<(bytes: Uint8Array, bins: number) => Promise<unknown>>()
vi.mock("./peaks", () => ({ decodePeaks: (...a: [Uint8Array, number]) => decodePeaks(...a) }))

const fetchPeaksSidecar = vi.fn<(args: Record<string, unknown>) => Promise<StoredPeaks | null>>()
const publishPeaksSidecarOnce = vi.fn<(args: Record<string, unknown>) => void>()
vi.mock("./peaks-sidecar", async (importOriginal) => ({
  peaksAtBins: (await importOriginal<typeof import("./peaks-sidecar")>()).peaksAtBins,
  fetchPeaksSidecar: (a: Record<string, unknown>) => fetchPeaksSidecar(a),
  publishPeaksSidecarOnce: (a: Record<string, unknown>) => publishPeaksSidecarOnce(a),
}))

import { loadPeaksFor, loadPeaksBatch } from "./peaks-loader"
import type { StoredPeaks } from "./peaks-sidecar"

const AUDIO_ID = "audio-cell1-1700000000-abcdefgh"
const EXT = "wav"
const KEY = `${AUDIO_ID}.${EXT}`
const URL = `frontier-audio://${AUDIO_ID}.${EXT}`
const BINS = 320

const getSyncToken = async () => "tok"
const base = { attachmentKey: KEY, url: URL, projectId: "p1", fileId: "f1", bins: BINS, getSyncToken }

function decoded(fill = 0.5) {
  return { peaks: new Float32Array(BINS).fill(fill), duration: 3, sampleRate: 48000 }
}

beforeEach(() => {
  vi.clearAllMocks()
  peaksCacheGet.mockResolvedValue(null)
  peaksCachePut.mockResolvedValue()
  audioCacheGet.mockResolvedValue(null)
  audioCachePut.mockResolvedValue()
  fetchCellAudio.mockResolvedValue(new Uint8Array([1, 2, 3]))
  decodePeaks.mockResolvedValue(decoded())
  fetchPeaksSidecar.mockResolvedValue(null)
})

describe("loadPeaksFor — the two cache keys", () => {
  it("reads the peaks cache under the ATTACHMENT KEY, extension included", async () => {
    await loadPeaksFor(base)
    expect(peaksCacheGet).toHaveBeenCalledWith(KEY, BINS)
  })

  it("reads the byte cache under the PARSED id and ext, extension separate", async () => {
    await loadPeaksFor(base)
    expect(audioCacheGet).toHaveBeenCalledWith(AUDIO_ID, EXT)
  })

  it("writes both caches back under those same two keys", async () => {
    await loadPeaksFor(base)
    expect(audioCachePut).toHaveBeenCalledWith(AUDIO_ID, EXT, expect.any(Uint8Array))
    expect(peaksCachePut).toHaveBeenCalledWith(KEY, expect.any(Float32Array))
  })
})

describe("loadPeaksFor — the ladder stops at the first rung that answers", () => {
  it("a peaks hit reads no bytes and decodes nothing", async () => {
    const cached = new Float32Array(BINS).fill(0.25)
    peaksCacheGet.mockResolvedValue(cached)

    await expect(loadPeaksFor(base)).resolves.toBe(cached)
    expect(audioCacheGet).not.toHaveBeenCalled()
    expect(fetchCellAudio).not.toHaveBeenCalled()
    expect(decodePeaks).not.toHaveBeenCalled()
  })

  it("a byte-cache hit decodes without touching the network", async () => {
    audioCacheGet.mockResolvedValue(new Uint8Array([9, 9]))

    await loadPeaksFor(base)
    expect(fetchCellAudio).not.toHaveBeenCalled()
    expect(decodePeaks).toHaveBeenCalledOnce()
    // Nothing new was downloaded, so nothing should be written back.
    expect(audioCachePut).not.toHaveBeenCalled()
    expect(peaksCachePut).toHaveBeenCalledOnce()
  })

  it("falls through to the network and fetches from the CLIP'S OWN file", async () => {
    // A take on an audio cue belongs to the hidden sibling, and its bytes live
    // under that file's path — not under the file the user is looking at.
    await loadPeaksFor({ ...base, fileId: "cue-sibling" })
    expect(fetchCellAudio).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "cue-sibling", audioId: AUDIO_ID, ext: EXT }),
    )
  })
})

// AQU-2095. The ticket's number: a chapter of takes cost ~400KB to DRAW,
// because a 20px rectangle was paid for with the whole recording. The sidecar
// is a few hundred stored bytes, so what matters is which rungs it sits
// between — above the clip, below anything already on this device — and that a
// clip we did pay for leaves its shape behind for the next reader.
describe("loadPeaksFor — the peaks sidecar", () => {
  it("draws from the stored shape instead of downloading the recording", async () => {
    const stored = new Float32Array(BINS).fill(0.75)
    fetchPeaksSidecar.mockResolvedValue({ peaks: stored, durationMs: 4000 })

    await expect(loadPeaksFor(base)).resolves.toBe(stored)
    expect(fetchCellAudio).not.toHaveBeenCalled()
    expect(decodePeaks).not.toHaveBeenCalled()
    // And it is kept locally, so the next draw costs no request at all.
    expect(peaksCachePut).toHaveBeenCalledWith(KEY, stored)
  })

  it("asks the clip's OWN file for it, as the clip's bytes are asked for", async () => {
    await loadPeaksFor({ ...base, fileId: "cue-sibling" })
    expect(fetchPeaksSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "cue-sibling", audioId: AUDIO_ID, ext: EXT }),
    )
  })

  it("is not consulted when the bytes are already on this device", async () => {
    audioCacheGet.mockResolvedValue(new Uint8Array([9, 9]))
    await loadPeaksFor(base)
    expect(fetchPeaksSidecar).not.toHaveBeenCalled()
  })

  it("downloads the clip when the stored shape has fewer bins than asked for", async () => {
    fetchPeaksSidecar.mockResolvedValue({ peaks: new Float32Array(64).fill(0.5), durationMs: null })
    await loadPeaksFor(base)
    expect(fetchCellAudio).toHaveBeenCalledOnce()
  })

  // WHY: the extension editor draws 160 bins. It used to ignore the shared
  // 320, download the clip, and write its own 160 over everyone else's shape.
  it("narrows the stored shape for a reader that wants fewer bins, and writes nothing", async () => {
    fetchPeaksSidecar.mockResolvedValue({ peaks: new Float32Array(BINS).fill(0.5), durationMs: 4000 })
    const peaks = await loadPeaksFor({ ...base, bins: BINS / 2 })
    expect(peaks?.length).toBe(BINS / 2)
    expect(fetchCellAudio).not.toHaveBeenCalled()
    expect(publishPeaksSidecarOnce).not.toHaveBeenCalled()
  })

  it("publishes the shape of a clip it had to download, for everyone after", async () => {
    await loadPeaksFor(base)
    expect(publishPeaksSidecarOnce).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: AUDIO_ID, ext: EXT, peaks: expect.any(Float32Array) }),
    )
  })

  it("publishes the clip's length with its shape", async () => {
    await loadPeaksFor(base)
    const call = publishPeaksSidecarOnce.mock.calls[0]![0] as { durationMs: number | null }
    expect(call.durationMs).toBeGreaterThan(0)
  })

  it("publishes nothing when the bytes would not decode", async () => {
    decodePeaks.mockRejectedValue(new Error("unsupported"))
    await expect(loadPeaksFor(base)).resolves.toBeNull()
    expect(publishPeaksSidecarOnce).not.toHaveBeenCalled()
  })
})

describe("loadPeaksFor — it gives up quietly, never loudly", () => {
  it("returns null for a legacy url that can never be fetched again", async () => {
    await expect(loadPeaksFor({ ...base, url: "https://gitlab.example/lfs/abc" })).resolves.toBeNull()
    expect(fetchCellAudio).not.toHaveBeenCalled()
  })

  it("returns null when the clip is gone, rather than throwing at the chip", async () => {
    fetchCellAudio.mockRejectedValue(new Error("404"))
    await expect(loadPeaksFor(base)).resolves.toBeNull()
  })

  it("returns null when the bytes will not decode", async () => {
    decodePeaks.mockRejectedValue(new Error("unsupported"))
    await expect(loadPeaksFor(base)).resolves.toBeNull()
  })

  it("still returns the peaks when caching them fails", async () => {
    peaksCachePut.mockRejectedValue(new Error("quota"))
    await expect(loadPeaksFor(base)).resolves.toBeInstanceOf(Float32Array)
  })

  it("survives an unreadable peaks cache by carrying on down the ladder", async () => {
    peaksCacheGet.mockRejectedValue(new Error("opfs gone"))
    await expect(loadPeaksFor(base)).resolves.toBeInstanceOf(Float32Array)
    expect(decodePeaks).toHaveBeenCalledOnce()
  })

  it("refuses a nonsense bin count without calling anything", async () => {
    await expect(loadPeaksFor({ ...base, bins: 0 })).resolves.toBeNull()
    expect(peaksCacheGet).not.toHaveBeenCalled()
  })
})

describe("loadPeaksBatch", () => {
  const targets = Array.from({ length: 6 }, (_, i) => ({
    attachmentKey: `audio-c${i}-1-aaaaaaaa.wav`,
    url: `frontier-audio://audio-c${i}-1-aaaaaaaa.wav`,
    fileId: "f1",
  }))

  it("reports each clip as it lands, not once at the end", async () => {
    const onLoaded = vi.fn()
    await loadPeaksBatch({ targets, projectId: "p1", bins: BINS, getSyncToken, onLoaded })
    expect(onLoaded).toHaveBeenCalledTimes(6)
  })

  it("never decodes more than two clips at once", async () => {
    let live = 0
    let peak = 0
    decodePeaks.mockImplementation(async () => {
      live += 1
      peak = Math.max(peak, live)
      await Promise.resolve()
      live -= 1
      return decoded()
    })

    await loadPeaksBatch({ targets, projectId: "p1", bins: BINS, getSyncToken })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("stops between clips once cancelled", async () => {
    const onLoaded = vi.fn()
    let cancelled = false
    await loadPeaksBatch({
      targets,
      projectId: "p1",
      bins: BINS,
      getSyncToken,
      isCancelled: () => cancelled,
      onLoaded: (...a) => {
        cancelled = true
        onLoaded(...a)
      },
    })
    // Two workers were already in flight when the flag flipped, so at most one
    // more can land. What must not happen is all six.
    expect(onLoaded.mock.calls.length).toBeLessThan(targets.length)
  })

  it("does not report a clip that finished after the file changed", async () => {
    const onLoaded = vi.fn()
    await loadPeaksBatch({
      targets, projectId: "p1", bins: BINS, getSyncToken,
      isCancelled: () => true,
      onLoaded,
    })
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it("skips a clip it cannot load and keeps going", async () => {
    decodePeaks.mockRejectedValueOnce(new Error("bad"))
    const onLoaded = vi.fn()
    await loadPeaksBatch({ targets, projectId: "p1", bins: BINS, getSyncToken, onLoaded })
    expect(onLoaded).toHaveBeenCalledTimes(5)
  })
})
