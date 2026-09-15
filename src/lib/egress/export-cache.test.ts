// The export cache holds full zips of everything the user could read — so the
// round-trip must be byte-faithful (a corrupted replay ships a corrupt org
// zip), failures must degrade to a miss (never break an export), and sign-out
// MUST drop it (shared devices must not leak org data across accounts).

import { beforeEach, describe, expect, it } from "vitest"
import {
  purgeEgressExportCache,
  readEgressCache,
  writeEgressCache,
  type EgressCacheEntry,
} from "./export-cache"
import { purgeAudioCachesOnSignOut } from "@/lib/audio/cache-cleanup"

const entry = (over: Partial<EgressCacheEntry> = {}): EgressCacheEntry => ({
  projectId: "p1",
  username: "alice",
  freshnessKey: "fresh-1",
  optionsHash: "opts-1",
  zipBlob: new Blob(["zip-bytes-here"], { type: "application/zip" }),
  report: {
    projectId: "p1",
    projectName: "Project One",
    freshnessKey: "fresh-1",
    fromCache: false,
    files: [{ fileId: "f1", fileName: "GEN.SFM", entries: ["fr/GEN.usfm"], skipped: [] }],
    errors: [],
  },
  sizeBytes: 14,
  cachedAt: 123,
  ...over,
})

beforeEach(async () => {
  await purgeEgressExportCache()
})

describe("egress export cache", () => {
  it("round-trips an entry byte-faithfully, including the zip blob", async () => {
    await writeEgressCache(entry())
    const got = await readEgressCache("p1")
    expect(got).not.toBeNull()
    expect(got!.freshnessKey).toBe("fresh-1")
    expect(got!.optionsHash).toBe("opts-1")
    // The account partition must survive the round-trip — a reader that gets
    // undefined back would replay another user's zip (AQU-616).
    expect(got!.username).toBe("alice")
    expect(got!.report.files[0].entries).toEqual(["fr/GEN.usfm"])
    expect(await got!.zipBlob.text()).toBe("zip-bytes-here")
    expect(got!.zipBlob.type).toBe("application/zip")
  })

  it("misses on unknown projects and keeps latest-only per project", async () => {
    expect(await readEgressCache("nope")).toBeNull()
    await writeEgressCache(entry())
    await writeEgressCache(entry({ freshnessKey: "fresh-2" }))
    // The stale entry must be REPLACED — a reader must never see the old
    // freshness key and replay an outdated zip.
    expect((await readEgressCache("p1"))!.freshnessKey).toBe("fresh-2")
  })

  it("purge drops everything", async () => {
    await writeEgressCache(entry())
    await writeEgressCache(entry({ projectId: "p2" }))
    await purgeEgressExportCache()
    expect(await readEgressCache("p1")).toBeNull()
    expect(await readEgressCache("p2")).toBeNull()
  })

  it("sign-out purges the egress cache even where OPFS is unavailable", async () => {
    // happy-dom has no navigator.storage.getDirectory — the OPFS-guarded early
    // return in purgeAudioCachesOnSignOut must NOT skip the IDB purge, or org
    // data survives sign-out on exactly the browsers that lack OPFS.
    await writeEgressCache(entry())
    await purgeAudioCachesOnSignOut()
    expect(await readEgressCache("p1")).toBeNull()
  })

  it("degrades to a miss (and a no-op write) without indexedDB", async () => {
    const g = globalThis as { indexedDB?: IDBFactory }
    const saved = g.indexedDB
    try {
      delete g.indexedDB
      expect(await readEgressCache("p1")).toBeNull()
      await expect(writeEgressCache(entry())).resolves.toBeUndefined()
      await expect(purgeEgressExportCache()).resolves.toBeUndefined()
    } finally {
      g.indexedDB = saved
    }
  })
})
