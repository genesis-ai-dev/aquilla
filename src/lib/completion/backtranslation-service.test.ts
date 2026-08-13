import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  buildBacktranslationPrompt,
  BACKTRANSLATION_SYSTEM_PROMPT,
  deriveTerminologyHints,
  generateBacktranslation,
} from "./backtranslation-service"
import type { Concept } from "@/lib/terminology/types"

// Mock the completion transport so we can assert on the constructed messages
// without making a network call.
const completeMock = vi.fn((_args: unknown): Promise<string> => Promise.resolve("mock backtranslation"))
vi.mock("./completion-service", () => ({
  complete: (args: unknown) => completeMock(args),
}))

type CompleteArg = { messages: { role: string; content: string }[] }
function lastCompleteArg(): CompleteArg {
  const call = completeMock.mock.calls[0]
  if (!call) throw new Error("complete() was not called")
  return call[0] as CompleteArg
}

describe("buildBacktranslationPrompt", () => {
  it("constructs system prompt with language placeholders", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour le monde",
      examples: [],
    })
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toContain("English")
    expect(messages[0].content).toContain("French")
    expect(messages[0].content).toContain("word-for-word")
  })

  it("includes target text in user message", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour le monde",
      examples: [],
    })
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("Bonjour le monde")
  })

  it("includes few-shot examples", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour",
      examples: [
        { target: "Je suis un chat", backtranslation: "I am a cat" },
        { target: "Le livre rouge", backtranslation: "The book red" },
      ],
    })
    const content = messages[1].content
    expect(content).toContain("Je suis un chat")
    expect(content).toContain("I am a cat")
    expect(content).toContain("Le livre rouge")
    expect(content).toContain("The book red")
    expect(content).toContain("Bonjour")
  })

  it("exports BACKTRANSLATION_SYSTEM_PROMPT constant", () => {
    expect(BACKTRANSLATION_SYSTEM_PROMPT).toContain("word-for-word")
    expect(BACKTRANSLATION_SYSTEM_PROMPT).toContain("{sourceLanguage}")
    expect(BACKTRANSLATION_SYSTEM_PROMPT).toContain("{targetLanguage}")
  })

  // WHY: terminology seeding must steer the literal BT toward the project's
  // controlled vocabulary. The preferred rendering AND the source headword it
  // maps to must both reach the model, or the LLM-BT stays blind to the
  // glossary the statistical glosser already respects.
  it("injects preferred renderings into the system prompt when hints are supplied", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "amour de Dieu",
      examples: [],
      terminologyHints: [{ sourceTerm: "grace", preferred: ["grâce", "faveur"] }],
    })
    const system = messages[0].content
    expect(system).toContain("grace")
    expect(system).toContain("grâce")
    expect(system).toContain("faveur")
    // The mapping direction (rendering → source headword) must be explicit.
    expect(system).toContain("→ grace")
  })

  // WHY: the feature is strictly additive. Omitting hints must leave the system
  // prompt byte-identical to the pre-seeding behavior (regression guard).
  it("leaves the system prompt unchanged when no hints are supplied", () => {
    const base = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour",
      examples: [],
    })
    const expected = BACKTRANSLATION_SYSTEM_PROMPT
      .replace(/\{sourceLanguage\}/g, "English")
      .replace(/\{targetLanguage\}/g, "French")
    expect(base[0].content).toBe(expected)

    // An empty hint array must also be a no-op.
    const empty = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour",
      examples: [],
      terminologyHints: [],
    })
    expect(empty[0].content).toBe(expected)
  })
})

describe("deriveTerminologyHints", () => {
  const concept = (over: Partial<Concept>): Concept => ({
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "grâce", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01",
    ...over,
  })

  it("returns a hint only when the source headword appears in the source text", () => {
    const concepts = [concept({})]
    expect(deriveTerminologyHints(concepts, "the grace of God")).toEqual([
      { sourceTerm: "grace", preferred: ["grâce"] },
    ])
    // Headword absent → no hint.
    expect(deriveTerminologyHints(concepts, "the love of God")).toEqual([])
  })

  it("matches the source headword case-insensitively", () => {
    expect(deriveTerminologyHints([concept({})], "GRACE abounds")).toEqual([
      { sourceTerm: "grace", preferred: ["grâce"] },
    ])
  })

  // WHY: only preferred renderings are positive guidance; admitted/forbidden
  // must never be surfaced as something the BT should produce.
  it("includes only preferred renderings, dropping admitted and forbidden", () => {
    const concepts = [
      concept({
        renderings: [
          { rendering: "grâce", status: "preferred" },
          { rendering: "faveur", status: "admitted" },
          { rendering: "chance", status: "forbidden" },
        ],
      }),
    ]
    expect(deriveTerminologyHints(concepts, "grace")).toEqual([
      { sourceTerm: "grace", preferred: ["grâce"] },
    ])
  })

  // WHY: only active vocabulary should steer output; draft/deprecated concepts
  // are not yet (or no longer) authoritative.
  it("skips non-active concepts and concepts with no preferred renderings", () => {
    const draft = concept({ id: "d", status: "draft" })
    const noPreferred = concept({
      id: "n",
      sourceTerm: "mercy",
      renderings: [{ rendering: "x", status: "admitted" }],
    })
    expect(deriveTerminologyHints([draft, noPreferred], "grace and mercy")).toEqual([])
  })

  it("returns [] for missing inputs", () => {
    expect(deriveTerminologyHints(undefined, "grace")).toEqual([])
    expect(deriveTerminologyHints([concept({})], undefined)).toEqual([])
    expect(deriveTerminologyHints([], "grace")).toEqual([])
  })
})

describe("generateBacktranslation terminology seeding", () => {
  beforeEach(() => {
    completeMock.mockClear()
  })

  const baseOptions = {
    sourceLanguage: "English",
    targetLanguage: "French",
    targetText: "amour de Dieu",
    examples: [],
    settings: {} as never,
    session: null,
  }

  // WHY: the end-to-end path (concepts + sourceText → derived hints → prompt
  // passed to complete()) must actually reach the transport.
  it("derives hints from concepts + sourceText and passes them to complete()", async () => {
    const concepts: Concept[] = [
      {
        id: "c1",
        sourceTerm: "grace",
        renderings: [{ rendering: "grâce", status: "preferred" }],
        status: "active",
        createdAt: "2026-01-01",
      },
    ]
    await generateBacktranslation({
      ...baseOptions,
      concepts,
      sourceText: "the grace of God",
    })
    expect(completeMock).toHaveBeenCalledTimes(1)
    const system = lastCompleteArg().messages.find((m) => m.role === "system")!.content
    expect(system).toContain("grâce")
    expect(system).toContain("→ grace")
  })

  // WHY: regression guard — with no terminology inputs the prompt must not gain
  // a glossary block.
  it("passes an unchanged system prompt to complete() when no terminology is supplied", async () => {
    await generateBacktranslation({ ...baseOptions })
    const system = lastCompleteArg().messages.find((m) => m.role === "system")!.content
    const expected = BACKTRANSLATION_SYSTEM_PROMPT
      .replace(/\{sourceLanguage\}/g, "English")
      .replace(/\{targetLanguage\}/g, "French")
    expect(system).toBe(expected)
  })

  // WHY: explicit terminologyHints must take precedence over derivation so a
  // caller that already computed hints isn't second-guessed.
  it("prefers explicit terminologyHints over concept derivation", async () => {
    await generateBacktranslation({
      ...baseOptions,
      terminologyHints: [{ sourceTerm: "spirit", preferred: ["esprit"] }],
      concepts: [
        {
          id: "c1",
          sourceTerm: "grace",
          renderings: [{ rendering: "grâce", status: "preferred" }],
          status: "active",
          createdAt: "2026-01-01",
        },
      ],
      sourceText: "the grace of God",
    })
    const system = lastCompleteArg().messages.find((m) => m.role === "system")!.content
    expect(system).toContain("esprit")
    expect(system).not.toContain("grâce")
  })
})

describe("AQU-848 — the configured source language reaches the request payload", () => {
  beforeEach(() => {
    completeMock.mockClear()
  })

  it("carries a low-resource source language through verbatim", () => {
    // The reported bug: a Gom-source project got English back-translations
    // because the call site defaulted to "English". The configured language
    // must reach the system message exactly as configured.
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "Gom",
      targetLanguage: "Gom",
      targetText: "…",
      examples: [],
    })
    expect(messages[0].content).toContain("BACK into Gom")
    expect(messages[0].content).not.toContain("English")
  })

  it("does not name English when the project has no source language", () => {
    // Unset must stay language-neutral rather than silently claiming English.
    for (const unset of ["", "   "]) {
      const messages = buildBacktranslationPrompt({
        sourceLanguage: unset,
        targetLanguage: "Gom",
        targetText: "…",
        examples: [],
      })
      expect(messages[0].content).toContain("BACK into the source language")
      expect(messages[0].content).not.toContain("English")
    }
  })

  it("still names English for a genuinely English-source project", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "Gom",
      targetText: "…",
      examples: [],
    })
    expect(messages[0].content).toContain("BACK into English")
  })

  it("sends the configured source language on the generated request", async () => {
    await generateBacktranslation({
      settings: { model: "m", temperature: 0.3 } as never,
      session: null,
      sourceLanguage: "Konkani (Goan)",
      targetLanguage: "Konkani (Goan)",
      targetText: "…",
      examples: [],
    })
    const system = lastCompleteArg().messages.find((m) => m.role === "system")
    expect(system?.content).toContain("Konkani (Goan)")
    expect(system?.content).not.toContain("English")
  })
})
