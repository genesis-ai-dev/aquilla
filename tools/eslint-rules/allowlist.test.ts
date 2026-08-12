import { describe, expect, it } from "vitest"
// @ts-expect-error - CommonJS module, no type declarations
import { isAllowedString, isIgnoredFile } from "./allowlist.cjs"

describe("i18n guard allowlist / isAllowedString", () => {
  it("allows pure punctuation, digits, and single glyphs", () => {
    expect(isAllowedString("")).toBe(true)
    expect(isAllowedString("   ")).toBe(true)
    expect(isAllowedString("·")).toBe(true)
    expect(isAllowedString("—")).toBe(true)
    expect(isAllowedString("42")).toBe(true)
    expect(isAllowedString(":")).toBe(true)
  })

  it("allows camelCase and CONST_CASE identifiers", () => {
    expect(isAllowedString("camelCaseThing")).toBe(true)
    expect(isAllowedString("SOME_CONST")).toBe(true)
  })

  it("allows URLs, file paths, and mime types", () => {
    expect(isAllowedString("https://aquilla.app")).toBe(true)
    expect(isAllowedString("ws://localhost:1234")).toBe(true)
    expect(isAllowedString("src/lib/i18n/messages/en.ts")).toBe(true)
    expect(isAllowedString("application/json")).toBe(true)
    expect(isAllowedString("en-US")).toBe(true)
  })

  it("allows a phrase made entirely of atomic terms, decomposed on separators", () => {
    expect(isAllowedString("USFM")).toBe(true)
    expect(isAllowedString("MP3 / WAV")).toBe(true)
    expect(isAllowedString("Ctrl + Enter")).toBe(true)
    expect(isAllowedString("USFM, USX")).toBe(true)
  })

  it("flags real user-visible phrases, including a phrase with one non-atomic word", () => {
    expect(isAllowedString("Save changes")).toBe(false)
    expect(isAllowedString("USFM file")).toBe(false)
    expect(isAllowedString("Delete this project?")).toBe(false)
  })
})

describe("i18n guard allowlist / isIgnoredFile", () => {
  it("ignores test and e2e files", () => {
    expect(isIgnoredFile("src/components/Foo.test.tsx")).toBe(true)
    expect(isIgnoredFile("src/components/Foo.spec.tsx")).toBe(true)
    expect(isIgnoredFile("src/components/__tests__/Foo.tsx")).toBe(true)
    expect(isIgnoredFile("e2e/specs/foo.spec.ts")).toBe(true)
  })

  it("ignores marketing and legal surfaces (deliberate scope decisions)", () => {
    expect(isIgnoredFile("src/pages/Homepage/Homepage.tsx")).toBe(true)
    expect(isIgnoredFile("src/pages/CaseStudy/Biblica.tsx")).toBe(true)
    expect(isIgnoredFile("src/pages/PrivacyPolicy.tsx")).toBe(true)
  })

  it("ignores platform-admin surfaces", () => {
    expect(isIgnoredFile("src/components/admin/AdminOverviewHome.tsx")).toBe(true)
    expect(isIgnoredFile("src/pages/AdminConsole.tsx")).toBe(true)
  })

  it("does not ignore ordinary application files, including a Terms-adjacent component", () => {
    expect(isIgnoredFile("src/components/GlossaryEditor.tsx")).toBe(false)
    // Named similarly to a legal page but not one — must stay linted.
    expect(isIgnoredFile("src/components/CandidateTermsPanel.tsx")).toBe(false)
  })
})
