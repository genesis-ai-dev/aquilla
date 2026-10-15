import { describe, expect, it } from "vitest"
import { buildSystemPrompt, buildUserPrompt, ClaudeTranslator, makeTranslator, PseudoTranslator, pseudoTranslate } from "../src/engine/translator.ts"
import { validateTagged } from "../src/core/tagged.ts"
import type { TranslationJob } from "../src/engine/translator.ts"

const job = (over: Partial<TranslationJob> = {}): TranslationJob => ({
  logicalId: "u1",
  sourceLocale: "en",
  targetLocale: "fr",
  sourceTagged: "<g1>Welcome</g1> to the church hall<x1/>",
  contextRevision: "c",
  policyRevision: "p",
  terms: [{ source: "church hall", target: "salle paroissiale" }],
  rules: ["Use the formal 'vous'."],
  prior: [{ logicalId: "u1", source: "Welcome to the hall", target: "Bienvenue dans la salle", authority: "human" }],
  ...over,
})

describe("translators", () => {
  it("pseudo output is deterministic, honours terms and keeps tags valid", () => {
    const a = pseudoTranslate(job())
    expect(a).toBe(pseudoTranslate(job()))
    expect(a).toContain("salle paroissiale")
    expect(validateTagged(job().sourceTagged, a)).toEqual([])
  })
  it("prompts carry glossary, rules and the human prior as authoritative", () => {
    const user = buildUserPrompt([job()])
    expect(user).toContain("church hall → salle paroissiale")
    expect(user).toContain("Use the formal 'vous'.")
    expect(user).toContain("human-approved translation")
    expect(buildSystemPrompt("en", "fr", "A choir.")).toMatch(/Keep every <xN\/> exactly once/)
  })
  it("selects translators from config", () => {
    expect(makeTranslator(undefined)).toBeInstanceOf(PseudoTranslator)
    expect(makeTranslator("claude")).toBeInstanceOf(ClaudeTranslator)
    expect(makeTranslator("claude:claude-sonnet-5-5").id).toBe("claude:claude-sonnet-5-5")
    expect(() => makeTranslator("gpt")).toThrow()
  })
})
