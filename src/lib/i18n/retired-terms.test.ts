import { describe, expect, it } from "vitest"
import { plural, type MessageValue } from "./plurals"
import { RETIRED_TERMS, retiredTermIssues, retiredTermsIn } from "./retired-terms"

/**
 * AQU-2261: the catalog check that keeps the word list. A retired word in an
 * English message fails, and the failure says what to write instead.
 */
const check = (catalog: Record<string, MessageValue>, allowlist: Record<string, string> = {}) =>
  retiredTermIssues(catalog, allowlist)

describe("retired words in English messages (AQU-2261)", () => {
  it("fails a retired word and names the word to use", () => {
    expect(check({ "x.title": "Open View settings" })).toEqual([
      'x.title: "View settings" → write "Editor settings"',
    ])
    expect(check({ "x.save": "Saved: audio media strategy." })).toEqual([
      'x.save: "audio media" → write "Media (the pane), or Audio loading (its card)"',
    ])
  })

  it("matches whatever the case", () => {
    expect(check({ a: "AUDIO MEDIA" })).toHaveLength(1)
    expect(check({ a: "advanced llm settings" })).toEqual([
      'a: "Advanced LLM" → write "AI model (advanced)"',
    ])
  })

  it("matches whole words only", () => {
    expect(check({ a: "Lanes" })).toHaveLength(1)
    expect(check({ a: "Planes and lanyards" })).toEqual([])
    expect(check({ a: "A rosterless team" })).toEqual([])
  })

  it("passes Language lane, in any case and the plural", () => {
    expect(
      check({
        a: "Language lane",
        b: "Language lanes",
        c: "Add it as a language lane on {projectName}",
        d: "All LANGUAGE LANES",
      }),
    ).toEqual([])
  })

  it('fails a bare "lane" beside a Language lane in the same message', () => {
    expect(check({ a: "Each language lane keeps its own lane." })).toEqual([
      'a: "lane" → write "Language lane (plural Language lanes)"',
    ])
  })

  it("reports a specific phrase once, not again as its last word", () => {
    expect(check({ a: "Every current target lane" })).toEqual([
      'a: "Target lane" → write "Language lane"',
    ])
  })

  it("ignores placeholder names, which nobody reads", () => {
    expect(check({ a: "Archive language lane {lane}", b: "{lanes} language lanes only" })).toEqual([])
  })

  it("fails a role's level number", () => {
    expect(check({ a: "Project lead (500) — default" })).toEqual([
      `a: "a role's level number, e.g. (500)" → write "the role's name alone, e.g. Project lead"`,
    ])
    expect(check({ a: "Saved (5000 cells)", b: "Take (2)" })).toEqual([])
  })

  it("checks every plural form", () => {
    const value = plural({ one: "Adds {count} more language lane.", other: "Adds {count} more lanes." })
    expect(check({ a: value })).toEqual(['a: "lane" → write "Language lane (plural Language lanes)"'])
  })

  it("passes an allowlisted key", () => {
    expect(check({ "admin.legacyName": "Local models (old name)" }, { "admin.legacyName": "quotes the old name" })).toEqual([])
    expect(check({ "admin.legacyName": "Local models (old name)" })).toHaveLength(1)
  })

  it("lists every retired term with a word to use instead", () => {
    for (const entry of RETIRED_TERMS) {
      expect(entry.use.trim()).not.toBe("")
      const sample = entry.term.startsWith("a role's") ? "Project lead (500)" : entry.term
      expect(retiredTermsIn(sample, [entry])).toHaveLength(1)
    }
  })

  it("finds none in the shipped English catalog", () => {
    expect(retiredTermIssues()).toEqual([])
  })
})
