import { describe, expect, it, vi } from "vitest"
import { cacheProjectMediaOffline, collectFrontierMedia, type CacheProjectMediaDeps } from "./media-cache"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

const session = { jwt: "jwt", username: "u" } as FrontierSession

describe("collectFrontierMedia", () => {
  // Takes, dubs and source clips each hang their pointers off different
  // metadata shapes; any new shape must be found without editing this module.
  it("finds R2 pointers at any depth, de-duplicated, and skips external URLs", () => {
    const row = {
      metadata: {
        takes: [{ url: "frontier-audio://a1.webm" }, { url: "frontier-audio://a2.wav" }],
        dub: { nested: { src: "frontier-audio://a1.webm" } },
        video: "https://youtube.com/watch?v=x",
      },
    }
    const found = [...collectFrontierMedia("f1", row).values()]
    expect(found).toEqual([
      { fileId: "f1", audioId: "a1", ext: "webm" },
      { fileId: "f1", audioId: "a2", ext: "wav" },
    ])
  })
})

function fakeDeps(cached: Set<string>, usage = 0, budget = 1_000): CacheProjectMediaDeps & { fetched: string[] } {
  const fetched: string[] = []
  const rows = [
    { cellId: "c1", metadata: { takes: [{ url: "frontier-audio://a1.webm" }] } },
    { cellId: "c2", metadata: { takes: [{ url: "frontier-audio://a2.webm" }, { url: "frontier-audio://gone.webm" }] } },
  ] as unknown as CellRow[]
  return {
    fetched,
    fetchSyncToken: vi.fn(async () => ({ token: "t" })) as unknown as CacheProjectMediaDeps["fetchSyncToken"],
    fetchProjectFiles: vi.fn(async () => [{ fileId: "f1" }]) as unknown as CacheProjectMediaDeps["fetchProjectFiles"],
    streamFileCells: vi.fn(async (_p, _f, _t, onPage) => {
      await onPage(rows, true)
    }) as CacheProjectMediaDeps["streamFileCells"],
    fetchCellAudio: vi.fn(async ({ audioId }) => {
      if (audioId === "gone") throw Object.assign(new Error("404"), { status: 404 })
      fetched.push(audioId)
      return new Uint8Array([1])
    }),
    cache: {
      available: async () => true,
      budget: async () => budget,
      usage: async () => usage,
      has: async (id) => cached.has(id),
      put: async (id) => {
        cached.add(id)
      },
    },
  }
}

describe("cacheProjectMediaOffline", () => {
  it("downloads only clips not already on the device, and keeps going past a missing one", async () => {
    const cached = new Set(["a1"])
    const deps = fakeDeps(cached)
    const result = await cacheProjectMediaOffline("p1", session, {}, deps)
    expect(result).toEqual({ total: 3, cached: 1, alreadyCached: 1, failed: 1, stopped: "done" })
    expect(deps.fetched).toEqual(["a2"])
    expect(cached.has("a2")).toBe(true)
  })

  // Saving for offline must never evict other clips to make room.
  it("stops instead of overfilling the cache budget", async () => {
    const deps = fakeDeps(new Set(), 1_000, 1_000)
    const result = await cacheProjectMediaOffline("p1", session, {}, deps)
    expect(result.stopped).toBe("budget")
    expect(deps.fetched).toEqual([])
  })
})
