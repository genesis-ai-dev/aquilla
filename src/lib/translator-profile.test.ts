import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getTranslatorProfile,
  setTranslatorProfile,
  onTranslatorProfileChange,
  sanitizeProfile,
  isProfileEmpty,
  profileForPrompt,
  effectiveResponseLanguage,
  translatorProfilePromptBlock,
  MAX_PROFILE_FIELD_CHARS,
} from "./translator-profile"

afterEach(() => {
  localStorage.clear()
})

describe("get/set", () => {
  it("returns an empty profile when nothing is stored", () => {
    expect(getTranslatorProfile()).toEqual({})
  })

  it("round-trips a profile and drops empty/whitespace fields", () => {
    setTranslatorProfile({ responseLanguage: "Tagalog", age: "32", gender: "   " })
    expect(getTranslatorProfile()).toEqual({ responseLanguage: "Tagalog", age: "32" })
  })

  it("survives corrupt JSON in storage", () => {
    localStorage.setItem("codex:translatorProfile", "{not json")
    expect(getTranslatorProfile()).toEqual({})
  })

  it("notifies subscribers on change with the sanitized value", () => {
    const seen = vi.fn()
    const off = onTranslatorProfileChange(seen)
    setTranslatorProfile({ responseLanguage: "  Swahili  ", otherInfo: "" })
    expect(seen).toHaveBeenCalledWith({ responseLanguage: "Swahili" })
    off()
  })
})

describe("sanitizeProfile", () => {
  it("trims, caps long fields, and omits empties", () => {
    const long = "x".repeat(MAX_PROFILE_FIELD_CHARS + 50)
    const clean = sanitizeProfile({ otherInfo: `  ${long}  `, age: "" })
    expect(clean.otherInfo).toHaveLength(MAX_PROFILE_FIELD_CHARS)
    expect("age" in clean).toBe(false)
  })

  it("ignores non-string values defensively", () => {
    // A server-sync future or hand-edited storage could carry junk.
    const clean = sanitizeProfile({ age: 32 as unknown as string })
    expect(clean).toEqual({})
  })
})

describe("isProfileEmpty / profileForPrompt", () => {
  it("treats a whitespace-only profile as empty", () => {
    expect(isProfileEmpty({ gender: "  " })).toBe(true)
    expect(profileForPrompt({ gender: "  " })).toBeNull()
  })

  it("returns the sanitized object when non-empty", () => {
    expect(profileForPrompt({ age: "40", religiousBackground: "" })).toEqual({ age: "40" })
  })
})

describe("effectiveResponseLanguage — profile overrides project", () => {
  it("uses the profile language when set, ignoring the project fallback", () => {
    expect(effectiveResponseLanguage({ responseLanguage: "Tagalog" }, "Spanish")).toBe("Tagalog")
  })

  it("falls back to the project chat language when the profile has none", () => {
    expect(effectiveResponseLanguage({ age: "32" }, "Spanish")).toBe("Spanish")
  })

  it("is undefined when neither is set", () => {
    expect(effectiveResponseLanguage({}, "")).toBeUndefined()
    expect(effectiveResponseLanguage(null, null)).toBeUndefined()
  })
})

describe("translatorProfilePromptBlock", () => {
  it("renders the profile as JSON and an explicit respond-in line", () => {
    const block = translatorProfilePromptBlock({ age: "32", responseLanguage: "Tagalog" }, "Tagalog")
    expect(block).toContain("## Translator profile")
    expect(block).toContain('"age": "32"')
    expect(block).toContain("Respond to the user in Tagalog.")
  })

  it("emits the respond-in line even when the profile is otherwise empty", () => {
    const block = translatorProfilePromptBlock({}, "Swahili")
    expect(block).not.toContain("## Translator profile")
    expect(block).toContain("Respond to the user in Swahili.")
  })

  it("returns an empty string when there is nothing to say", () => {
    expect(translatorProfilePromptBlock({}, "")).toBe("")
    expect(translatorProfilePromptBlock(null)).toBe("")
  })
})
