import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildPrompt, complete, fetchModels, normalizeOpenAIBaseUrl, resolveProvider, DEFAULT_SYSTEM_PROMPT, FRONTIER_CHAT_URL } from "./completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

const BASE: CompletionSettings = {
  endpoint: "",
  model: "",
  maxTokens: 128,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: 0.1,
}

const SESSION: FrontierSession = {
  jwt: "jwt-abc",
  gitlabToken: "glpat",
  gitlabUrl: "https://git.genesisrnd.com",
  username: "tester",
  createdAt: new Date().toISOString(),
}

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

describe("normalizeOpenAIBaseUrl", () => {
  it("appends /v1/... to a bare host", () => {
    expect(normalizeOpenAIBaseUrl("http://localhost:8000")).toEqual({
      chatUrl: "http://localhost:8000/v1/chat/completions",
      modelsUrl: "http://localhost:8000/v1/models",
    })
  })

  it("strips trailing slashes", () => {
    expect(normalizeOpenAIBaseUrl("http://localhost:8000/")).toEqual({
      chatUrl: "http://localhost:8000/v1/chat/completions",
      modelsUrl: "http://localhost:8000/v1/models",
    })
  })

  it("recognizes an existing /v1 suffix", () => {
    expect(normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1")).toEqual({
      chatUrl: "https://openrouter.ai/api/v1/chat/completions",
      modelsUrl: "https://openrouter.ai/api/v1/models",
    })
  })

  it("recognizes a full chat/completions URL", () => {
    expect(normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toEqual({
      chatUrl: "https://openrouter.ai/api/v1/chat/completions",
      modelsUrl: "https://openrouter.ai/api/v1/models",
    })
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

  it("sends API key as Bearer when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ data: [{ id: "x" }] }),
    })
    vi.stubGlobal("fetch", fetchMock)
    await fetchModels("https://openrouter.ai/api/v1", "sk-or-secret")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://openrouter.ai/api/v1/models")
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-or-secret" })
    vi.unstubAllGlobals()
  })

  it("omits Authorization when no API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ data: [] }),
    })
    vi.stubGlobal("fetch", fetchMock)
    await fetchModels("http://localhost:8000")
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it("throws on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }))
    await expect(fetchModels("http://localhost:8000")).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})

describe("resolveProvider", () => {
  it("returns explicit provider when set", () => {
    expect(resolveProvider({ ...BASE, provider: "frontier", endpoint: "http://x" })).toBe("frontier")
    expect(resolveProvider({ ...BASE, provider: "custom" })).toBe("custom")
  })

  it("infers 'frontier' when provider missing and endpoint blank (new default)", () => {
    expect(resolveProvider({ ...BASE, endpoint: "" })).toBe("frontier")
  })

  it("infers 'custom' when provider missing but legacy endpoint is populated", () => {
    expect(resolveProvider({ ...BASE, endpoint: "http://localhost:8000" })).toBe("custom")
  })
})

describe("complete", () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset() })
  afterEach(() => { vi.unstubAllGlobals() })

  function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  }

  const msg = [{ role: "user" as const, content: "hi" }]

  it("frontier: POSTs to Frontier URL with Bearer JWT and model='default' when blank", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "translated" } }] }))
    const out = await complete({ settings: { ...BASE, provider: "frontier" }, session: SESSION, messages: msg })
    expect(out).toBe("translated")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(FRONTIER_CHAT_URL)
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer jwt-abc",
      "Content-Type": "application/json",
    })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe("default")
    expect(body.messages).toEqual(msg)
  })

  it("frontier: uses explicit model override when provided", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "ok" } }] }))
    await complete({
      settings: { ...BASE, provider: "frontier", model: "anthropic/claude-3.5-sonnet" },
      session: SESSION, messages: msg,
    })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe("anthropic/claude-3.5-sonnet")
  })

  it("frontier: throws 'Sign in' when session is null", async () => {
    await expect(
      complete({ settings: { ...BASE, provider: "frontier" }, session: null, messages: msg }),
    ).rejects.toThrow(/Sign in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("frontier: surfaces 402 subscription-limit errors with server message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Monthly credits exhausted", { status: 402 }))
    await expect(
      complete({ settings: { ...BASE, provider: "frontier" }, session: SESSION, messages: msg }),
    ).rejects.toThrow(/Frontier AI limit reached: Monthly credits exhausted/)
  })

  it("custom: POSTs to {endpoint}/v1/chat/completions without auth", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "yes" } }] }))
    await complete({
      settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", model: "gemma" },
      session: null, messages: msg,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://localhost:8000/v1/chat/completions")
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined()
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe("gemma")
  })

  it("custom: sends Bearer <apiKey> when configured (OpenRouter)", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "yes" } }] }))
    await complete({
      settings: {
        ...BASE, provider: "custom",
        endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-secret",
        model: "anthropic/claude-3.5-sonnet",
      },
      session: null, messages: msg,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-or-secret" })
  })

  it("custom: trims whitespace from apiKey", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "yes" } }] }))
    await complete({
      settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", apiKey: "  sk-123  " },
      session: null, messages: msg,
    })
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk-123",
    })
  })

  it("custom: blank apiKey does not add Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "yes" } }] }))
    await complete({
      settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", apiKey: "   " },
      session: null, messages: msg,
    })
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it("custom: throws when endpoint is blank", async () => {
    await expect(
      complete({ settings: { ...BASE, provider: "custom", endpoint: "" }, session: null, messages: msg }),
    ).rejects.toThrow(/No custom endpoint/)
  })
})
