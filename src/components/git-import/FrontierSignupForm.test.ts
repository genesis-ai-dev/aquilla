import { describe, it, expect } from "vitest"
import { checkPasswordRequirements, passwordStrength } from "./FrontierSignupForm"

describe("checkPasswordRequirements", () => {
  it("fails minLength when < 8 chars", () => {
    expect(checkPasswordRequirements("short", "")).toMatchObject({ minLength: false })
  })

  it("passes minLength when >= 8 chars", () => {
    expect(checkPasswordRequirements("longenough", "")).toMatchObject({ minLength: true })
  })

  it("fails notContainsEmail when password contains email local part", () => {
    const result = checkPasswordRequirements("alice123!", "alice@example.com")
    expect(result.notContainsEmail).toBe(false)
  })

  it("passes notContainsEmail when password does not contain email local part", () => {
    const result = checkPasswordRequirements("secret123!", "alice@example.com")
    expect(result.notContainsEmail).toBe(true)
  })

  it("treats notContainsEmail as true when email is too short to check", () => {
    const result = checkPasswordRequirements("ab12345678", "ab@x.com")
    expect(result.notContainsEmail).toBe(true)
  })

  it("is case-insensitive for email-in-password check", () => {
    const result = checkPasswordRequirements("ALICE123!", "alice@example.com")
    expect(result.notContainsEmail).toBe(false)
  })
})

describe("passwordStrength", () => {
  it("returns weak for empty password", () => {
    expect(passwordStrength("")).toBe("weak")
  })

  it("returns weak for short password", () => {
    expect(passwordStrength("abc")).toBe("weak")
  })

  it("returns medium for 8-char password with digits", () => {
    expect(passwordStrength("abcdef12")).toBe("medium")
  })

  it("returns strong for long password with digits and symbols", () => {
    expect(passwordStrength("Secur3P@ssword!")).toBe("strong")
  })
})
