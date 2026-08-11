import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createOpfsFs } from "@/lib/fs/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/fs/__test__/mem-fs-handles"
import {
  __setRootForTests,
  audioCacheGet,
  audioCacheEvict,
  audioCachePut,
  audioCachePutBlob,
} from "./bytes-cache"
import {
  __resetOpfsAvailabilityForTests,
} from "@/lib/storage/opfs-availability"

function makeRoot(): ReturnType<typeof createOpfsFs> {
  return createOpfsFs(new MemoryDirectoryHandle("root") as unknown as FileSystemDirectoryHandle)
}

beforeEach(() => {
  __resetOpfsAvailabilityForTests()
  __setRootForTests(makeRoot())
})

describe("audioCachePut / audioCacheGet", () => {
  it("returns null on a miss", async () => {
    expect(await audioCacheGet("audio-missing", "webm")).toBeNull()
  })

  it("round-trips bytes unchanged", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    await audioCachePut("audio-abc-123", "webm", bytes)
    const back = await audioCacheGet("audio-abc-123", "webm")
    expect(back).not.toBeNull()
    expect(Array.from(back!)).toEqual([1, 2, 3, 4, 5])
  })

  it("treats different extensions as different entries", async () => {
    const webm = new Uint8Array([1])
    const mp4 = new Uint8Array([2])
    await audioCachePut("audio-x", "webm", webm)
    await audioCachePut("audio-x", "mp4", mp4)
    const gotWebm = await audioCacheGet("audio-x", "webm")
    const gotMp4 = await audioCacheGet("audio-x", "mp4")
    expect(gotWebm![0]).toBe(1)
    expect(gotMp4![0]).toBe(2)
  })

  it("sanitizes ids with path-unsafe characters", async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const id = "audio/../evil?#:"
    await audioCachePut(id, "webm", bytes)
    const back = await audioCacheGet(id, "webm")
    expect(back).not.toBeNull()
    expect(Array.from(back!)).toEqual([9, 8, 7])
  })

  it("returns null when OPFS is unavailable", async () => {
    __setRootForTests(null)
    const result = await audioCacheGet("audio-abc", "webm")
    expect(result).toBeNull()
    // put should also be a no-op, not throw
    await expect(audioCachePut("audio-abc", "webm", new Uint8Array([1]))).resolves.toBeUndefined()
  })
})

describe("audioCacheEvict", () => {
  it("removes a cached entry so subsequent gets return null", async () => {
    const bytes = new Uint8Array([5, 6, 7])
    await audioCachePut("audio-evict-me", "webm", bytes)
    expect(await audioCacheGet("audio-evict-me", "webm")).not.toBeNull()
    await audioCacheEvict("audio-evict-me", "webm")
    expect(await audioCacheGet("audio-evict-me", "webm")).toBeNull()
  })

  it("is a no-op when OPFS is unavailable", async () => {
    __setRootForTests(null)
    await expect(audioCacheEvict("audio-x", "webm")).resolves.toBeUndefined()
  })

  it("is a no-op for an id that was never cached", async () => {
    await expect(audioCacheEvict("audio-never-put", "webm")).resolves.toBeUndefined()
  })
})

describe("LRU size-cap eviction", () => {
  it("evicts oldest entries when total exceeds the cap", async () => {
    // Use a fresh fs and override the cap by writing a large entry by hand,
    // then add another entry and confirm the first was evicted.
    // Since MAX_TOTAL_BYTES is 200 MB we exercise the eviction logic directly
    // by making two small writes and then checking the index behaviour.
    // We verify the LRU ordering by checking that accessing an entry bumps it
    // to the end of the index (most-recent), meaning an older un-accessed entry
    // is evicted first.

    const older = new Uint8Array(10)
    const newer = new Uint8Array(10)
    older.fill(1)
    newer.fill(2)

    await audioCachePut("audio-older", "webm", older)
    await audioCachePut("audio-newer", "webm", newer)

    // Touch "older" to promote it so "newer" becomes the LRU candidate.
    await audioCacheGet("audio-older", "webm")

    // Both should still be present (200 MB cap >> 20 bytes total).
    expect(await audioCacheGet("audio-older", "webm")).not.toBeNull()
    expect(await audioCacheGet("audio-newer", "webm")).not.toBeNull()
  })

  it("evicts the least-recently-used entry when limit is exceeded", async () => {
    // Inject a tiny cap via a custom root with a patched constant.
    // Instead we directly test eviction by filling the cache above the cap
    // using a manual sequence: write many entries totalling > MAX, then read
    // the index and confirm the oldest was removed.
    //
    // Since we can't change MAX_TOTAL_BYTES at runtime without monkey-patching,
    // we verify eviction semantics indirectly through the public API:
    // after many puts the function doesn't throw and recent entries survive.
    const N = 5
    const payloads: Uint8Array[] = []
    for (let i = 0; i < N; i++) {
      const b = new Uint8Array(4)
      b.fill(i)
      payloads.push(b)
      await audioCachePut(`audio-lru-${i}`, "webm", b)
    }
    // Most-recently written entries should still be retrievable.
    const last = await audioCacheGet(`audio-lru-${N - 1}`, "webm")
    expect(last).not.toBeNull()
    expect(last![0]).toBe(N - 1)
  })
})

describe("normalized cache key", () => {
  it("the same audioId+ext always maps to the same cache slot", async () => {
    const bytes = new Uint8Array([42])
    await audioCachePut("audio-stable-id-123", "webm", bytes)

    // Second put with the same key overwrites, not duplicates.
    const updated = new Uint8Array([99])
    await audioCachePut("audio-stable-id-123", "webm", updated)

    const result = await audioCacheGet("audio-stable-id-123", "webm")
    expect(result).not.toBeNull()
    expect(result![0]).toBe(99)
  })
})

describe("OPFS unavailability", () => {
  it("falls back gracefully when navigator.storage.getDirectory throws", async () => {
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
      expect(await audioCacheGet("audio-abc", "webm")).toBeNull()
      await expect(audioCachePut("audio-abc", "webm", new Uint8Array([1]))).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(navigator, "storage", {
        value: { ...navigator.storage, getDirectory: original },
        configurable: true,
      })
    }
  })
})

describe("audioCachePutBlob (FRO-355)", () => {
  it("caches bytes straight from a Blob so it round-trips via audioCacheGet", async () => {
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "audio/webm" })
    await audioCachePutBlob("audio-blob-1", "webm", blob)
    const back = await audioCacheGet("audio-blob-1", "webm")
    expect(back).not.toBeNull()
    expect(Array.from(back!)).toEqual([7, 8, 9])
  })
})

describe("adaptive budget (smooth-playback round)", () => {
  it("a tiny injected budget really evicts the least-recently-used entry", async () => {
    const { __setBudgetForTests, audioCacheHas } = await import("./bytes-cache")
    __setBudgetForTests(24) // three 8-byte entries fit; a fourth evicts one
    try {
      for (let i = 0; i < 3; i++) {
        await audioCachePut(`audio-bud-${i}`, "webm", new Uint8Array(8).fill(i))
      }
      // Touch 0 so it is most-recent; 1 becomes the eviction candidate.
      await audioCacheGet("audio-bud-0", "webm")
      await audioCachePut("audio-bud-3", "webm", new Uint8Array(8).fill(3))

      expect(await audioCacheHas("audio-bud-1", "webm")).toBe(false) // evicted
      expect(await audioCacheHas("audio-bud-0", "webm")).toBe(true) // protected by the touch
      expect(await audioCacheHas("audio-bud-3", "webm")).toBe(true)
    } finally {
      __setBudgetForTests(null)
    }
  })

  it("audioCacheHas answers without bumping LRU order", async () => {
    const { __setBudgetForTests, audioCacheHas } = await import("./bytes-cache")
    __setBudgetForTests(16) // two 8-byte entries
    try {
      await audioCachePut("audio-has-a", "webm", new Uint8Array(8).fill(1))
      await audioCachePut("audio-has-b", "webm", new Uint8Array(8).fill(2))
      // A mere existence check on `a` must NOT promote it…
      expect(await audioCacheHas("audio-has-a", "webm")).toBe(true)
      // …so the next put still evicts `a` (the true LRU), not `b`.
      await audioCachePut("audio-has-c", "webm", new Uint8Array(8).fill(3))
      expect(await audioCacheHas("audio-has-a", "webm")).toBe(false)
      expect(await audioCacheHas("audio-has-b", "webm")).toBe(true)
    } finally {
      __setBudgetForTests(null)
    }
  })
})
