import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach } from "vitest"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import * as cache from "../cache"

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

describe("lfsCache", () => {
  let root: MemoryDirectoryHandle

  beforeEach(() => {
    root = new MemoryDirectoryHandle("root")
    cache.__setRootForTests(createOpfsFs(root as unknown as FileSystemDirectoryHandle))
  })

  it("returns null on cache miss", async () => {
    const out = await cache.lfsCacheGet("a".repeat(64))
    expect(out).toBeNull()
  })

  it("writes and reads bytes verbatim", async () => {
    const bytes = new TextEncoder().encode("hello audio")
    const oid = await sha256Hex(bytes)
    await cache.lfsCachePut(oid, bytes)
    const got = await cache.lfsCacheGet(oid)
    expect(got).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(got!)).toBe("hello audio")
  })

  it("rejects put when sha256 doesn't match oid", async () => {
    const bytes = new TextEncoder().encode("not the right bytes")
    const wrongOid = "b".repeat(64)
    await expect(cache.lfsCachePut(wrongOid, bytes)).rejects.toThrow(/integrity/i)
    const got = await cache.lfsCacheGet(wrongOid)
    expect(got).toBeNull()
  })

  it("shards storage by first two hex characters of the oid", async () => {
    const bytes = new TextEncoder().encode("x")
    const oid = await sha256Hex(bytes)
    await cache.lfsCachePut(oid, bytes)

    const first2 = oid.slice(0, 2)
    const lfsDir = await root.getDirectoryHandle("lfs-cache")
    const shard = await lfsDir.getDirectoryHandle(first2)
    const file = await shard.getFileHandle(oid)
    expect(file).toBeDefined()
  })
})
