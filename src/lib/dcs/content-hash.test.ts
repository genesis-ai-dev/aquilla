import { describe, it, expect } from "vitest"
import { contentHash } from "./content-hash"

// This MUST match the server's djb2 at
// sync-worker/src/events/event-projection.ts:56 exactly, so the delta engine's
// no-op suppression agrees with the server's change-detection marker. If these
// diverge, an unchanged cell would be re-emitted (or a changed one skipped).
describe("contentHash (port of server djb2)", () => {
  it("hashes the empty string to the djb2 seed 5381 = 0x00001505", () => {
    // 5381 >>> 0 in hex, padded to 8 = "00001505".
    expect(contentHash("")).toBe("00001505")
  })

  it("is deterministic for the same input", () => {
    expect(contentHash("In the beginning God created")).toBe(
      contentHash("In the beginning God created"),
    )
  })

  it("produces an 8-char zero-padded lowercase hex string", () => {
    for (const s of ["a", "Titus 1:1", "the quick brown fox", "x".repeat(500)]) {
      expect(contentHash(s)).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it("distinguishes different inputs", () => {
    expect(contentHash("Paul, a servant of God")).not.toBe(
      contentHash("Paul, an apostle of God"),
    )
  })

  it("is byte-for-byte identical to the reference djb2 computed inline", () => {
    // Reference implementation copied verbatim from the server so this test
    // fails loudly if the port drifts.
    const ref = (text: string): string => {
      let h = 5381
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) + h + text.charCodeAt(i)) | 0
      }
      return (h >>> 0).toString(16).padStart(8, "0")
    }
    for (const s of ["", "a", "TIT 1:1 Paul", "éè", "line1\nline2", " trailing "]) {
      expect(contentHash(s)).toBe(ref(s))
    }
  })
})
