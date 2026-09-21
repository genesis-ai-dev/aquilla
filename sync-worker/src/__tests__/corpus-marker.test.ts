import { describe, expect, it } from "vitest"
import {
  resolveCorpusMarker,
  usableCorpusMarker,
} from "../events/corpus-marker"

describe("usableCorpusMarker", () => {
  it("trims and accepts a named folder", () => {
    expect(usableCorpusMarker("  Treasure Hunt Bible  ")).toBe("Treasure Hunt Bible")
  })

  it("drops blank or over-long values", () => {
    expect(usableCorpusMarker("")).toBeUndefined()
    expect(usableCorpusMarker("   ")).toBeUndefined()
    expect(usableCorpusMarker("x".repeat(129))).toBeUndefined()
    expect(usableCorpusMarker(3)).toBeUndefined()
  })
})

describe("resolveCorpusMarker", () => {
  it("prefers an explicit marker over parserVersion", () => {
    expect(resolveCorpusMarker({
      corpusMarker: "My Notes",
      parserVersion: "builtin:biblica-treasure-hunt@1",
    })).toBe("My Notes")
  })

  it("recovers each Biblica edition folder from parserVersion", () => {
    expect(resolveCorpusMarker({ parserVersion: "builtin:biblica-study-notes@1" }))
      .toBe("Biblica Study Notes")
    expect(resolveCorpusMarker({ parserVersion: "builtin:biblica-treasure-hunt@1" }))
      .toBe("Treasure Hunt Bible")
    expect(resolveCorpusMarker({ parserVersion: "builtin:biblica-reach4life@1" }))
      .toBe("Reach 4 Life")
    expect(resolveCorpusMarker({ parserVersion: "builtin:biblica-ebl@1" }))
      .toBe("Equipping Biblical Leaders")
  })

  it("leaves ungrouped files without a marker", () => {
    expect(resolveCorpusMarker({})).toBeUndefined()
    expect(resolveCorpusMarker({ parserVersion: "builtin:idml-roundtrip@2" })).toBeUndefined()
  })
})
