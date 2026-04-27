import { describe, it, expect } from "vitest"
import { anonymousNameFor, displayNameFor, isPlaceholderUsername } from "./anonymous-name"

describe("anonymousNameFor", () => {
  it("is deterministic for the same clientId", () => {
    expect(anonymousNameFor("12345")).toBe(anonymousNameFor("12345"))
    expect(anonymousNameFor(12345)).toBe(anonymousNameFor("12345"))
  })

  it("produces a two-word adjective+noun string", () => {
    const name = anonymousNameFor("3093090065")
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })

  it("varies across nearby clientIds", () => {
    const names = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => anonymousNameFor(n))
    expect(new Set(names).size).toBeGreaterThan(1)
  })
})

describe("isPlaceholderUsername", () => {
  it("treats empty/local/anonymous as placeholders", () => {
    expect(isPlaceholderUsername("")).toBe(true)
    expect(isPlaceholderUsername(null)).toBe(true)
    expect(isPlaceholderUsername(undefined)).toBe(true)
    expect(isPlaceholderUsername("local")).toBe(true)
    expect(isPlaceholderUsername("LOCAL")).toBe(true)
    expect(isPlaceholderUsername("anonymous")).toBe(true)
  })

  it("treats real usernames as non-placeholder", () => {
    expect(isPlaceholderUsername("ryder")).toBe(false)
    expect(isPlaceholderUsername("ada-lovelace")).toBe(false)
  })
})

describe("displayNameFor", () => {
  it("returns the friendly name when username is a placeholder", () => {
    const display = displayNameFor("local", "999")
    expect(display).toBe(anonymousNameFor("999"))
  })

  it("passes through real usernames unchanged", () => {
    expect(displayNameFor("ryder", "999")).toBe("ryder")
  })
})
