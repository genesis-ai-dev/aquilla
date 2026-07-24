import { describe, it, expect } from "vitest"
import { secureCompare } from "../lib/secure-compare"

describe("secureCompare", () => {
  it("returns true for identical strings", () => {
    expect(secureCompare("Bearer abc123", "Bearer abc123")).toBe(true)
  })

  it("returns false for different strings of the same length", () => {
    expect(secureCompare("Bearer abc123", "Bearer abc124")).toBe(false)
  })

  it("returns false for different-length strings without throwing", () => {
    expect(secureCompare("short", "a much longer string")).toBe(false)
  })

  it("returns false against an empty string", () => {
    expect(secureCompare("", "Bearer abc123")).toBe(false)
  })

  it("returns true for two empty strings", () => {
    expect(secureCompare("", "")).toBe(true)
  })
})
