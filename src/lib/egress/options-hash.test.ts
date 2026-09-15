// The options hash decides whether a cached per-project export is reused.
// A false MATCH ships stale/wrong content; a false MISS silently throws away
// the cache's whole value. So: irrelevant differences (key order, set order,
// the useCache toggle itself) must not change the hash, and every content-
// affecting difference must.

import { describe, expect, it } from "vitest"
import { canonicalJson, computeOptionsHash, EGRESS_ENGINE_VERSION } from "./options-hash"
import type { EgressOptions } from "./types"

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("")
}

const baseOptions: EgressOptions = {
  textMode: "original",
  convertFormat: "txt",
  lanes: ["", "fr-CA"],
  includeSourceDocs: true,
  audioMode: "none",
  useCache: true,
}
const fileIds = ["f1", "f2"]

describe("computeOptionsHash", () => {
  it("is a stable sha256 hex for identical requests", async () => {
    const a = await computeOptionsHash(baseOptions, fileIds)
    const b = await computeOptionsHash({ ...baseOptions }, [...fileIds])
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toBe(a)
  })

  it("ignores object key order (canonical JSON)", async () => {
    // Same values, different insertion order — must hash identically or the
    // cache misses depending on how the UI happened to assemble the object.
    const reordered: EgressOptions = {
      useCache: true,
      audioMode: "none",
      includeSourceDocs: true,
      lanes: ["", "fr-CA"],
      convertFormat: "txt",
      textMode: "original",
    }
    expect(await computeOptionsHash(reordered, fileIds)).toBe(
      await computeOptionsHash(baseOptions, fileIds),
    )
  })

  it("ignores selection and lane ORDER — they are sets, not sequences", async () => {
    const a = await computeOptionsHash(baseOptions, ["f2", "f1"])
    const b = await computeOptionsHash({ ...baseOptions, lanes: ["fr-CA", ""] }, ["f1", "f2"])
    expect(a).toBe(await computeOptionsHash(baseOptions, fileIds))
    expect(b).toBe(await computeOptionsHash(baseOptions, fileIds))
  })

  it("excludes useCache — toggling reuse must not invalidate what it reuses", async () => {
    expect(await computeOptionsHash({ ...baseOptions, useCache: false }, fileIds)).toBe(
      await computeOptionsHash(baseOptions, fileIds),
    )
  })

  it("folds the engine version so v1-era cache keys (no version field) can never match", async () => {
    // v1 shipped a zero-audio bug: cached zips built before the fix must be
    // unreachable forever, not until the project next changes. The v1 payload
    // had no engineVersion — reconstruct its exact hash and prove mismatch.
    const { useCache: _useCache, ...rest } = baseOptions
    const v1Hash = await sha256Hex(
      canonicalJson({
        options: { ...rest, lanes: [...rest.lanes].sort() },
        fileIds: [...fileIds].sort(),
      }),
    )
    expect(await computeOptionsHash(baseOptions, fileIds)).not.toBe(v1Hash)
    // The zero-audio fix landed in v2 — never roll the constant back.
    expect(EGRESS_ENGINE_VERSION).toBeGreaterThanOrEqual(2)
  })

  it("changes when any content-affecting option or the selection changes", async () => {
    const base = await computeOptionsHash(baseOptions, fileIds)
    expect(await computeOptionsHash({ ...baseOptions, textMode: "convert" }, fileIds)).not.toBe(base)
    expect(await computeOptionsHash({ ...baseOptions, convertFormat: "md" }, fileIds)).not.toBe(base)
    expect(await computeOptionsHash({ ...baseOptions, lanes: [""] }, fileIds)).not.toBe(base)
    expect(await computeOptionsHash({ ...baseOptions, includeSourceDocs: false }, fileIds)).not.toBe(base)
    expect(await computeOptionsHash({ ...baseOptions, audioMode: "file-clip" }, fileIds)).not.toBe(base)
    expect(await computeOptionsHash(baseOptions, ["f1"])).not.toBe(base)
    expect(await computeOptionsHash(baseOptions, ["f1", "f3"])).not.toBe(base)
  })
})
