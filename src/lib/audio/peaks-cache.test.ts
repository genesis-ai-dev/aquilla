import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { __setRootForTests, peaksCacheGet, peaksCachePut } from "./peaks-cache"
import {
  __resetOpfsAvailabilityForTests,
  isOpfsAvailable,
} from "@/lib/storage/opfs-availability"

beforeEach(() => {
  __resetOpfsAvailabilityForTests()
  __setRootForTests(createOpfsFs(new MemoryDirectoryHandle("root") as unknown as FileSystemDirectoryHandle))
})

describe("peaks cache", () => {
  it("round-trips a Float32Array unchanged", async () => {
    const peaks = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.5, 0])
    await peaksCachePut("audio-cell-123-456789-abc", peaks)
    const back = await peaksCacheGet("audio-cell-123-456789-abc", peaks.length)
    expect(back).not.toBeNull()
    expect(Array.from(back!)).toEqual(Array.from(peaks))
  })

  it("returns null on a miss", async () => {
    expect(await peaksCacheGet("nope", 200)).toBeNull()
  })

  it("returns null when the requested bin count doesn't match the stored payload", async () => {
    const peaks = new Float32Array(100)
    await peaksCachePut("audio-x", peaks)
    expect(await peaksCacheGet("audio-x", 200)).toBeNull()
    expect(await peaksCacheGet("audio-x", 100)).not.toBeNull()
  })

  it("sanitizes ids that contain path separators or unsafe chars", async () => {
    const peaks = new Float32Array([0.1, 0.2, 0.3])
    const messy = "audio/../etc/passwd?:#"
    await peaksCachePut(messy, peaks)
    const back = await peaksCacheGet(messy, 3)
    expect(back).not.toBeNull()
    expect(back!.length).toBe(3)
  })

  // Repro: in Safari Private Browsing the OPFS root throws UnknownError. We
  // must treat that as a cache miss / no-op so the audio stack can still
  // stream without the user seeing a Retry-waveform error state forever.
  it("treats OPFS unavailability as a cache miss instead of throwing", async () => {
    __setRootForTests(null)
    const original = navigator.storage?.getDirectory
    const stub = vi
      .fn()
      .mockRejectedValue(new DOMException("denied", "UnknownError"))
    Object.defineProperty(navigator, "storage", {
      value: { ...navigator.storage, getDirectory: stub },
      configurable: true,
    })
    try {
      const back = await peaksCacheGet("audio-x", 200)
      expect(back).toBeNull()
      await expect(peaksCachePut("audio-x", new Float32Array(200))).resolves.toBeUndefined()
      expect(isOpfsAvailable()).toBe(false)
    } finally {
      Object.defineProperty(navigator, "storage", {
        value: { ...navigator.storage, getDirectory: original },
        configurable: true,
      })
    }
  })
})
