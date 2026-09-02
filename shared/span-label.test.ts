import { describe, expect, it } from "vitest"
import {
  cellDisplayTag,
  collapseListToRange,
  formatSpanRange,
  friendlyScriptureLabel,
  humanPassageLabel,
  isOpaqueId,
  joinPassageLabels,
} from "./span-label"

describe("span-label", () => {
  it("treats full and truncated UUIDs as opaque", () => {
    expect(isOpaqueId("01920000-0000-7000-8000-000000000001")).toBe(true)
    expect(isOpaqueId("01920000…00000008")).toBe(true)
    expect(isOpaqueId("01920000-0000-7000-8000-000000000001…01920000-0000-7000-8000-000000000008")).toBe(true)
    expect(isOpaqueId("GEN 1:1")).toBe(false)
    expect(isOpaqueId("1–12")).toBe(false)
  })

  it("prefers verse refs, then tags, then cue times, then ordinals", () => {
    expect(cellDisplayTag({ canonicalRef: "LUK 1:1", ordinal: 4 })).toBe("LUK 1:1")
    expect(cellDisplayTag({ metadata: { spreadsheetLabel: "Row A" }, ordinal: 4 })).toBe("Row A")
    expect(cellDisplayTag({ startMs: 90_000, ordinal: 4 })).toBe("1:30")
    expect(cellDisplayTag({ ordinal: 4 })).toBe("4")
    expect(cellDisplayTag({ canonicalRef: "01920000-0000-7000-8000-000000000001", ordinal: 4 })).toBe("4")
  })

  it("formats a span as first–last, not a member list", () => {
    expect(formatSpanRange(
      { canonicalRef: "LUK 1:1", ordinal: 1 },
      { canonicalRef: "LUK 1:8", ordinal: 8 },
    )).toBe("LUK 1:1–LUK 1:8")
    expect(formatSpanRange({ ordinal: 1 }, { ordinal: 12 })).toBe("1–12")
    expect(formatSpanRange({ startMs: 1_000, endMs: 4_000 }, { startMs: 8_000, endMs: 12_000 })).toBe("0:01–0:12")
    expect(formatSpanRange({ canonicalRef: "GEN 1:1" }, { canonicalRef: "GEN 1:1" })).toBe("GEN 1:1")
  })

  it("collapses opaque id lists to a 1-based range", () => {
    expect(collapseListToRange([
      "01920000-0000-7000-8000-000000000001",
      "01920000-0000-7000-8000-000000000002",
      "01920000-0000-7000-8000-000000000003",
    ])).toBe("1–3")
    expect(collapseListToRange(["GEN 1:1", "GEN 1:2", "GEN 1:8"])).toBe("GEN 1:1–GEN 1:8")
    expect(humanPassageLabel("01920000-0000-7000-8000-000000000001")).toBeNull()
  })

  it("keeps distinct already-ranged passages, and ranges a cell-tag list", () => {
    expect(joinPassageLabels(["LUK 1:1–1:8", "LUK 1:9–1:15"])).toBe("LUK 1:1–1:8 · LUK 1:9–1:15")
    expect(joinPassageLabels(["1", "2", "12"])).toBe("1–12")
    expect(joinPassageLabels(["01920000-0000-7000-8000-000000000001"])).toBeNull()
  })

  it("expands USFM codes so a preview can say Genesis instead of GEN", () => {
    expect(friendlyScriptureLabel("GEN 1:1")).toBe("Genesis 1:1")
    expect(friendlyScriptureLabel("GEN 1:1–GEN 1:8")).toBe("Genesis 1:1–8")
    expect(friendlyScriptureLabel("GEN 1:1–1:8")).toBe("Genesis 1:1–8")
    expect(friendlyScriptureLabel("GEN 1:31–GEN 2:4")).toBe("Genesis 1:31–2:4")
    expect(friendlyScriptureLabel("1–12")).toBe("1–12")
  })
})
