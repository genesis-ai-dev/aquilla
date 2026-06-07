/**
 * Tests for RuleEditor logic helpers (FRO-195).
 * Tests pattern→RuleCheck mapping, literal escaping, and regex validation.
 * No React render required — pure logic tests.
 */
import { describe, it, expect } from "vitest"
import { escapeRegex, validateRegex } from "./RuleEditor"

describe("escapeRegex", () => {
  it("escapes special regex characters", () => {
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c")
    expect(escapeRegex("(hello)")).toBe("\\(hello\\)")
    expect(escapeRegex("$1.00")).toBe("\\$1\\.00")
  })

  it("returns plain strings unchanged", () => {
    expect(escapeRegex("hello world")).toBe("hello world")
    expect(escapeRegex("abc123")).toBe("abc123")
  })

  it("escapes backslashes", () => {
    expect(escapeRegex("a\\b")).toBe("a\\\\b")
  })
})

describe("validateRegex", () => {
  it("returns null for valid patterns", () => {
    expect(validateRegex("\\d+")).toBeNull()
    expect(validateRegex("[a-z]+")).toBeNull()
    expect(validateRegex("(foo|bar)")).toBeNull()
  })

  it("returns null for empty string (no pattern yet)", () => {
    expect(validateRegex("")).toBeNull()
  })

  it("returns error message for invalid regex", () => {
    const err = validateRegex("[unclosed")
    expect(err).not.toBeNull()
    expect(typeof err).toBe("string")
    expect(err!.length).toBeGreaterThan(0)
  })

  it("returns error for unbalanced group", () => {
    const err = validateRegex("(abc")
    expect(err).not.toBeNull()
  })
})

// Integration: verify that escaping a literal produces a safe regex
describe("escapeRegex → safe RegExp", () => {
  it("can construct a RegExp from any escaped literal", () => {
    const inputs = ["$1.00", "a+b", "(test)", "\\n", "[]"]
    for (const s of inputs) {
      const escaped = escapeRegex(s)
      // Should not throw
      expect(() => new RegExp(escaped)).not.toThrow()
      // Should match the original literal string exactly
      const re = new RegExp(escaped)
      expect(re.test(s)).toBe(true)
    }
  })
})
