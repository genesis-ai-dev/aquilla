import { describe, it, expect, vi } from "vitest"
import { buildPrompt, fetchModels, DEFAULT_SYSTEM_PROMPT } from "./completion-service"

describe("buildPrompt", () => {
  it("builds a prompt with examples and source text", () => {
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "In the beginning",
      examples: [{ source: "God created", target: "Dieu crea" }, { source: "the heavens", target: "les cieux" }],
    })
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toContain("English")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("God created")
    expect(messages[1].content).toContain("In the beginning")
  })

  it("builds a prompt with no examples", () => {
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "Hello world", examples: [],
    })
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toContain("Hello world")
  })

  it("uses custom system prompt with placeholders", () => {
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "Spanish",
      systemPrompt: "Translate {sourceLanguage} to {targetLanguage}.", sourceText: "test", examples: [],
    })
    expect(messages[0].content).toBe("Translate English to Spanish.")
  })
})

describe("fetchModels", () => {
  it("extracts model IDs from /v1/models response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ object: "list", data: [{ id: "gemma-4-26B" }, { id: "llama-3" }] }),
    }))
    const models = await fetchModels("http://localhost:8000")
    expect(models).toEqual(["gemma-4-26B", "llama-3"])
    vi.unstubAllGlobals()
  })

  it("throws on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }))
    await expect(fetchModels("http://localhost:8000")).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
