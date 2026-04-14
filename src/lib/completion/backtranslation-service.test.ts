import { describe, it, expect } from "vitest"
import { buildBacktranslationPrompt, BACKTRANSLATION_SYSTEM_PROMPT } from "./backtranslation-service"

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
})
