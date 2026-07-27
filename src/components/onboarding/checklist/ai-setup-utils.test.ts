import { describe, it, expect } from "vitest"
import { formatMb, isValidGeminiKey, describeModelDownload } from "./ai-setup-utils"

describe("isValidGeminiKey", () => {
  it("accepts a well-formed AIza key", () => {
    expect(isValidGeminiKey("AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r")).toBe(true)
  })
  it("trims surrounding whitespace before validating", () => {
    expect(isValidGeminiKey("  AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p  ")).toBe(true)
  })
  it("rejects empty / whitespace-only input (no silent acceptance)", () => {
    expect(isValidGeminiKey("")).toBe(false)
    expect(isValidGeminiKey("   ")).toBe(false)
  })
  it("rejects input that doesn't start with AIza", () => {
    expect(isValidGeminiKey("sk-1234567890abcdefghijklmnop")).toBe(false)
    expect(isValidGeminiKey("https://aistudio.google.com/apikey")).toBe(false)
  })
  it("rejects a truncated key", () => {
    expect(isValidGeminiKey("AIza123")).toBe(false)
  })
})

describe("formatMb", () => {
  it("rounds to a whole number at/above 10 MB", () => {
    expect(formatMb(140 * 1024 * 1024)).toBe("140 MB")
  })
  it("keeps one decimal below 10 MB", () => {
    expect(formatMb(1.5 * 1024 * 1024)).toBe("1.5 MB")
  })
  it("guards non-positive / non-finite input", () => {
    expect(formatMb(0)).toBe("0 MB")
    expect(formatMb(Number.NaN)).toBe("0 MB")
  })
})

describe("describeModelDownload", () => {
  it("reports percent and MB when total is known", () => {
    const r = describeModelDownload(
      { kind: "downloading", loaded: 70 * 1024 * 1024, total: 140 * 1024 * 1024, file: "model.onnx" },
      140,
    )
    expect(r.pct).toBe(50)
    expect(r.label).toBe("50% · 70 MB / 140 MB")
  })
  it("clamps percent to 0..100", () => {
    const over = describeModelDownload(
      { kind: "downloading", loaded: 200, total: 100, file: "f" },
      140,
    )
    expect(over.pct).toBe(100)
  })
  it("falls back to loaded-vs-advertised size when Content-Length is missing", () => {
    const r = describeModelDownload(
      { kind: "downloading", loaded: 20 * 1024 * 1024, total: 0, file: "f" },
      140,
    )
    expect(r.pct).toBeNull()
    expect(r.label).toBe("20 MB of ~140 MB")
  })
  it("shows a starting state with the advertised size before any bytes land", () => {
    const r = describeModelDownload(
      { kind: "downloading", loaded: 0, total: 0, file: "" },
      140,
    )
    expect(r.pct).toBeNull()
    expect(r.label).toContain("~140 MB")
  })
})
