// AQU-433 — resolveApiKey precedence: project > user > org
//
// Verifies the three-tier fallback chain introduced in AQU-433.
//   1. project key beats user key and org key
//   2. user key beats org key when no project key is set
//   3. org key is used as last resort when neither project nor user key is set
//   4. undefined is returned when all three are absent / empty

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { resolveApiKey, setUserApiKey } from "./user-api-keys"

// localStorage is available in happy-dom/jsdom test environments.
beforeEach(() => {
  // Clear any lingering user keys.
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe("resolveApiKey — three-tier precedence (AQU-433)", () => {
  it("returns the project key when all three are set (project wins)", () => {
    setUserApiKey("gemini-tts", "user-key")
    const result = resolveApiKey("gemini-tts", "project-key", "org-key")
    expect(result).toBe("project-key")
  })

  it("returns the user key when no project key is set", () => {
    setUserApiKey("gemini-tts", "user-key")
    const result = resolveApiKey("gemini-tts", undefined, "org-key")
    expect(result).toBe("user-key")
  })

  it("returns the user key when project key is an empty string", () => {
    setUserApiKey("gemini-tts", "user-key")
    const result = resolveApiKey("gemini-tts", "", "org-key")
    expect(result).toBe("user-key")
  })

  it("returns the user key when project key is whitespace-only", () => {
    setUserApiKey("gemini-tts", "user-key")
    const result = resolveApiKey("gemini-tts", "   ", "org-key")
    expect(result).toBe("user-key")
  })

  it("returns the org key when neither project nor user key is set", () => {
    // No call to setUserApiKey — user key absent.
    const result = resolveApiKey("gemini-tts", undefined, "org-key")
    expect(result).toBe("org-key")
  })

  it("returns undefined when all three are absent", () => {
    const result = resolveApiKey("gemini-tts", undefined, undefined)
    expect(result).toBeUndefined()
  })

  it("returns undefined when project + org are empty and user key is absent", () => {
    const result = resolveApiKey("gemini-tts", "", "")
    expect(result).toBeUndefined()
  })

  it("trims whitespace from the org key", () => {
    const result = resolveApiKey("gemini-tts", undefined, "  org-key-padded  ")
    expect(result).toBe("org-key-padded")
  })

  it("ignores whitespace-only org key (returns undefined)", () => {
    const result = resolveApiKey("gemini-tts", undefined, "   ")
    expect(result).toBeUndefined()
  })
})
