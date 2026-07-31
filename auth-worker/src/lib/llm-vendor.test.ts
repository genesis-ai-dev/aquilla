import { describe, it, expect } from "vitest"
import { isOpenRouterUpstream, openRouterUsage, openRouterExtras } from "./llm-vendor"

describe("isOpenRouterUpstream", () => {
  it("treats an unset/blank override as OpenRouter (the built-in default)", () => {
    expect(isOpenRouterUpstream(undefined)).toBe(true)
    expect(isOpenRouterUpstream("")).toBe(true)
    expect(isOpenRouterUpstream("   ")).toBe(true)
  })

  it("recognizes an explicit OpenRouter base URL", () => {
    expect(isOpenRouterUpstream("https://openrouter.ai/api/v1")).toBe(true)
    expect(isOpenRouterUpstream("https://openrouter.ai/api/v1/chat/completions")).toBe(true)
    expect(isOpenRouterUpstream("https://gateway.openrouter.ai/api/v1")).toBe(true)
  })

  it("rejects other upstreams", () => {
    expect(isOpenRouterUpstream("https://api.groq.com/openai/v1")).toBe(false)
    expect(isOpenRouterUpstream("https://api.anthropic.com/v1")).toBe(false)
    expect(isOpenRouterUpstream("http://127.0.0.1:9456/api/v1")).toBe(false)
  })

  it("does not match a lookalike host", () => {
    expect(isOpenRouterUpstream("https://openrouter.ai.evil.test/v1")).toBe(false)
    expect(isOpenRouterUpstream("https://notopenrouter.ai/v1")).toBe(false)
  })

  it("treats an unparseable override as non-OpenRouter", () => {
    expect(isOpenRouterUpstream("not a url")).toBe(false)
  })
})

describe("openRouterUsage / openRouterExtras", () => {
  it("emits the vendor fields for OpenRouter", () => {
    expect(openRouterUsage(undefined)).toEqual({ usage: { include: true } })
    expect(openRouterExtras(undefined)).toEqual({
      usage: { include: true },
      reasoning: { effort: "none" },
    })
    expect(openRouterExtras("https://openrouter.ai/api/v1", "high")).toEqual({
      usage: { include: true },
      reasoning: { effort: "high" },
    })
  })

  // Groq rejects unknown request properties outright:
  //   400 {"error":{"message":"property 'reasoning' is unsupported"}}
  it("emits nothing for a non-OpenRouter upstream", () => {
    expect(openRouterUsage("https://api.groq.com/openai/v1")).toEqual({})
    expect(openRouterExtras("https://api.groq.com/openai/v1")).toEqual({})
    expect(openRouterExtras("https://api.groq.com/openai/v1", "high")).toEqual({})
  })

  it("spreads cleanly into a chat-completions body", () => {
    const groqBody = { model: "llama-3.3-70b-versatile", ...openRouterExtras("https://api.groq.com/openai/v1") }
    expect(Object.keys(groqBody)).toEqual(["model"])
    expect(JSON.parse(JSON.stringify(groqBody))).not.toHaveProperty("reasoning")
  })
})
