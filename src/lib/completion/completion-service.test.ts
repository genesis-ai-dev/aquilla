import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildPrompt, buildBatchPrompt, complete, fetchModels, normalizeOpenAIBaseUrl, resolveProvider, DEFAULT_SYSTEM_PROMPT, FRONTIER_CHAT_URL, collectValidatedPairs, buildRulesBlock, buildBriefBlock, activeProjectIdFromPath } from "./completion-service"
import type { CompletionSettings, TranslationRule } from "@/lib/parsers/types"
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

  it("drops examples with an empty target so no blank 'Translation:' leaks into the prompt", () => {
    // The branching-search corpus keeps source-only cells (untranslated), so
    // retrieval can hand us pairs with an empty target. A blank target teaches
    // the model nothing and corrupts the few-shot pattern — it must be filtered.
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "live source",
      examples: [
        { source: "God created", target: "Dieu crea" },
        { source: "untranslated source", target: "" },
        { source: "  ", target: "orphan target" },
      ],
    })
    expect(messages[1].content).toContain("God created")
    expect(messages[1].content).not.toContain("untranslated source")
    expect(messages[1].content).not.toContain("orphan target")
    // One complete example + the live source line.
    expect((messages[1].content.match(/Source: /g) || []).length).toBe(2)
  })

  it("appends systemAddendum to the system message — after the rules block, custom prompts included", () => {
    const rules: TranslationRule[] = [{
      id: "r1", name: "r1", description: "", severity: "minor", source: "user",
      scope: "project", enabled: true, createdAt: new Date().toISOString(),
      check: { type: "target-forbids", targetPattern: "forbidden-word" },
    }]
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: "Translate {sourceLanguage} to {targetLanguage}.",
      sourceText: "test", examples: [], rules,
      systemAddendum: "Footnote output: also return [n] lines.",
    })
    const sys = messages[0].content
    expect(sys.startsWith("Translate English to French.")).toBe(true)
    expect(sys.endsWith("Footnote output: also return [n] lines.")).toBe(true)
    expect(sys.indexOf("forbidden-word")).toBeLessThan(sys.indexOf("Footnote output"))
    // Never leaks into the user message.
    expect(messages[1].content).not.toContain("Footnote output")
  })

  it("renders preSourceBlock in the user message before — never inside — the final Source: line", () => {
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "Base[1] text.",
      examples: [{ source: "God created", target: "Dieu crea" }],
      precedingContext: [{ source: "prev src", target: "prev tgt" }],
      preSourceBlock: "Source footnotes for the [n] markers in the source line below:\n[1] a note",
    })
    const user = messages[1].content
    // The message still ends with the bare live-source frame; the block sits
    // between the discourse window and the final Source: line.
    expect(user.endsWith("Source: Base[1] text.\nTranslation:")).toBe(true)
    const blockIdx = user.indexOf("Source footnotes for")
    expect(blockIdx).toBeGreaterThan(user.indexOf("prev tgt"))
    expect(blockIdx).toBeLessThan(user.lastIndexOf("Source: Base[1] text."))
    // The block is not part of the system message.
    expect(messages[0].content).not.toContain("Source footnotes for")
  })

  it("is byte-identical to the pre-addendum output when neither new param is passed", () => {
    const options = {
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "Hello world",
      examples: [{ source: "God created", target: "Dieu crea" }],
    }
    const plain = buildPrompt(options)
    const withUndefined = buildPrompt({ ...options, systemAddendum: undefined, preSourceBlock: undefined })
    expect(withUndefined).toEqual(plain)
    expect(plain[1].content.endsWith("Source: Hello world\nTranslation:")).toBe(true)
  })
})

describe("buildBatchPrompt", () => {
  it("appends a format-specific output contract to the system prompt", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "<p data-idml-version=\"2\">protected</p>" }],
      examples: [],
      systemAddendum: "PRESERVE-IDML-ANCHORS",
    })
    expect(messages[0].content).toContain("PRESERVE-IDML-ANCHORS")
    expect(messages[1].content).not.toContain("PRESERVE-IDML-ANCHORS")
  })

  it("frames live cells as numbered <vN> tags and asks for the same structure back", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "In the beginning" }, { source: "God created" }, { source: "the heavens" }],
      examples: [],
    })
    expect(messages).toHaveLength(2)
    // Framing instructions live in the system prompt, not the user prompt — keeps
    // the per-call user message focused on content.
    expect(messages[0].content).toMatch(/<v1>, <v2>/)
    expect(messages[0].content).toContain("English")
    expect(messages[0].content).toContain("French")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("<v1>In the beginning</v1>")
    expect(messages[1].content).toContain("<v2>God created</v2>")
    expect(messages[1].content).toContain("<v3>the heavens</v3>")
    // Trails with "Translation:" so the model continues the segmented structure.
    expect(messages[1].content.endsWith("Translation:")).toBe(true)
  })

  it("renders examples with mirrored <vN> tags on both source and translation sides", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "live cell" }],
      examples: [
        { cells: [{ source: "Hello", target: "Bonjour" }, { source: "world", target: "monde" }] },
      ],
    })
    expect(messages[1].content).toContain("<v1>Hello</v1>\n<v2>world</v2>")
    expect(messages[1].content).toContain("<v1>Bonjour</v1>\n<v2>monde</v2>")
  })

  it("substitutes language placeholders in the user-supplied system prompt", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "Greek", targetLanguage: "Spanish",
      systemPrompt: "Translate from {sourceLanguage} to {targetLanguage}.",
      cells: [{ source: "x" }], examples: [],
    })
    expect(messages[0].content).toContain("Translate from Greek to Spanish.")
  })

  it("skips examples whose cells array is empty", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "x" }],
      examples: [{ cells: [] }, { cells: [{ source: "good", target: "bon" }] }],
    })
    // Only the non-empty example is rendered.
    expect((messages[1].content.match(/Source:/g) || []).length).toBe(2) // 1 example + 1 live
  })

  it("drops passage cells with an empty target, keeping source/target <vN> aligned", () => {
    // Passage neighbors include untranslated context cells. Rendering them would
    // emit a blank <vN> on the translation side and misalign the demonstrated
    // source/target columns. Filter pairwise before rendering.
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "live cell" }],
      examples: [
        { cells: [
          { source: "Hello", target: "Bonjour" },
          { source: "untranslated", target: "" },
          { source: "world", target: "monde" },
        ] },
      ],
    })
    // Surviving pairs are re-numbered contiguously — no gap from the dropped cell.
    expect(messages[1].content).toContain("<v1>Hello</v1>\n<v2>world</v2>")
    expect(messages[1].content).toContain("<v1>Bonjour</v1>\n<v2>monde</v2>")
    expect(messages[1].content).not.toContain("untranslated")
  })

  it("skips an example whose cells all have empty targets", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "x" }],
      examples: [
        { cells: [{ source: "a", target: "" }, { source: "b", target: "  " }] },
        { cells: [{ source: "good", target: "bon" }] },
      ],
    })
    expect(messages[1].content).not.toContain("<v1>a</v1>")
    expect((messages[1].content.match(/Source:/g) || []).length).toBe(2) // 1 surviving example + 1 live
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

  it("tolerates undefined endpoint (partial record from server overlay)", () => {
    // Simulates the overlaySettings path that previously produced
    // completionSettings = { systemPrompt } with endpoint missing,
    // crashing the workspace render with TypeError on `endpoint.trim()`.
    const partial = { systemPrompt: "x" } as unknown as CompletionSettings
    expect(() => resolveProvider(partial)).not.toThrow()
    expect(resolveProvider(partial)).toBe("frontier")
  })
})

describe("complete", () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

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

  // AQU-414 follow-up: frontier chat invoked from a project route carries the
  // project id so the server bills the spend to that project's org.
  describe("projectId attribution (AQU-414 follow-up)", () => {
    afterEach(() => {
      window.history.pushState({}, "", "/")
    })

    it("frontier: includes projectId from the current /project/:id/editor route", async () => {
      window.history.pushState({}, "", "/project/proj-uuid-1/editor/file/file-uuid-2")
      fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "ok" } }] }))
      await complete({ settings: { ...BASE, provider: "frontier" }, session: SESSION, messages: msg })
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      expect(body.projectId).toBe("proj-uuid-1")
    })

    it("frontier: omits projectId off project routes (spend stays at the no-org fallback)", async () => {
      window.history.pushState({}, "", "/preferences")
      fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "ok" } }] }))
      await complete({ settings: { ...BASE, provider: "frontier" }, session: SESSION, messages: msg })
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      expect(body).not.toHaveProperty("projectId")
    })

    it("custom: never sends projectId — third-party OpenAI-compatible endpoints may reject unknown fields", async () => {
      window.history.pushState({}, "", "/project/proj-uuid-1/editor")
      fetchMock.mockResolvedValueOnce(okJson({ choices: [{ message: { content: "ok" } }] }))
      await complete({
        settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", model: "gemma" },
        session: null, messages: msg,
      })
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      expect(body).not.toHaveProperty("projectId")
    })
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

  it("terminates a hung completion request with a retryable timeout error", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"))
        }, { once: true })
      }),
    )
    const pending = complete({
      settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", model: "x" },
      session: null,
      messages: msg,
      timeoutMs: 25,
    })
    const rejection = expect(pending).rejects.toThrow(
      "The AI request timed out. Please try again.",
    )

    await vi.advanceTimersByTimeAsync(25)

    await rejection
  })

  // Helper to build a streaming Response from a sequence of byte chunks.
  function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }

  it("stream: accumulates content even when SSE frames split across chunk boundaries", async () => {
    // Simulate Cloudflare-style fragmentation: a single SSE event arrives split
    // across two reads. The naive split-by-\n-per-read parser loses this data.
    fetchMock.mockResolvedValueOnce(streamResponse([
      `data: {"choices":[{"delta":{"content":"Hel`,
      `lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n`,
    ]))
    const pieces: string[] = []
    const out = await complete({
      settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", model: "x" }, session: null, messages: msg,
      stream: true, onChunk: (t) => pieces.push(t),
    })
    expect(out).toBe("Hello world")
    expect(pieces.at(-1)).toBe("Hello world")
  })

  it("stream: surfaces server-sent error chunks as thrown errors", async () => {
    // Streaming endpoints return HTTP 200 then embed errors inline. The client
    // must throw so callers see the failure instead of an empty string.
    fetchMock.mockResolvedValueOnce(streamResponse([
      `data: {"error":"subscription_limit","message":"Monthly credits exhausted"}\n\n`,
    ]))
    await expect(complete({
      settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", model: "x" }, session: null, messages: msg,
      stream: true, onChunk: () => {},
    })).rejects.toThrow(/Monthly credits exhausted/)
  })

  it("stream: handles multi-byte UTF-8 split across chunks", async () => {
    // "é" is 0xC3 0xA9 — split it between reads to verify decoder stream mode.
    const bytes = new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"café"}}]}\n\ndata: [DONE]\n\n`)
    // Find byte index of 'é' first byte and split there.
    const idx = [...bytes].findIndex((b) => b === 0xc3)
    const chunks = [bytes.slice(0, idx + 1), bytes.slice(idx + 1)]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const out = await complete({
      settings: { ...BASE, provider: "custom", endpoint: "http://localhost:8000", model: "x" }, session: null, messages: msg,
      stream: true, onChunk: () => {},
    })
    expect(out).toBe("café")
  })

  it("frontier: streams when the caller requests stream (workaround removed, Phase 0)", async () => {
    // The frontier provider used to force stream:false to dodge a chunk-drop
    // bug in the long-gone chat-worker SSE proxy. The current worker passes
    // bytes through unmodified, so frontier must stream like any provider —
    // incremental tokens are the UX (silence reads as broken, spec §8).
    fetchMock.mockResolvedValueOnce(streamResponse([
      `data: {"choices":[{"delta":{"content":"trans"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"lated"}}]}\n\ndata: [DONE]\n\n`,
    ]))
    const pieces: string[] = []
    const out = await complete({
      settings: { ...BASE, provider: "frontier" }, session: SESSION, messages: msg,
      stream: true, onChunk: (t) => pieces.push(t),
    })
    expect(out).toBe("translated")
    expect(pieces).toEqual(["trans", "translated"])
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.stream).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Living Memory: collectValidatedPairs
// ---------------------------------------------------------------------------

describe("collectValidatedPairs", () => {
  const cells = [
    { status: "validated", original: "God created the heavens", translated: "Dieu créa les cieux" },
    { status: "validated", original: "In the beginning", translated: "Au commencement" },
    { status: "unvalidated", original: "the earth was formless", translated: "la terre était sans forme" },
    { status: "empty", original: "void", translated: "" },
    { status: "validated", original: "", translated: "empty source excluded" },
  ]

  it("returns only validated cells with non-empty source and target", () => {
    const pairs = collectValidatedPairs(cells)
    expect(pairs).toHaveLength(2)
    expect(pairs.every((p) => p.source && p.target)).toBe(true)
  })

  it("returns empty array when no validated cells exist", () => {
    const result = collectValidatedPairs([
      { status: "unvalidated", original: "hello", translated: "bonjour" },
    ])
    expect(result).toEqual([])
  })

  it("respects the limit parameter", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      status: "validated",
      original: `source ${i}`,
      translated: `target ${i}`,
    }))
    const result = collectValidatedPairs(many, undefined, 10)
    expect(result).toHaveLength(10)
  })

  it("ranks pairs with overlapping tokens ahead of non-overlapping when query is provided", () => {
    const queryCells = [
      { status: "validated", original: "God created light", translated: "Dieu créa la lumière" },
      { status: "validated", original: "the earth was dark", translated: "la terre était sombre" },
      { status: "validated", original: "God created animals", translated: "Dieu créa les animaux" },
    ]
    // query shares "God created" — expect those two ranked first
    const pairs = collectValidatedPairs(queryCells, "God created the world", 3)
    expect(pairs[0].source).toContain("God created")
    expect(pairs[1].source).toContain("God created")
    expect(pairs[2].source).toBe("the earth was dark")
  })

  it("falls back to insertion order when query is absent", () => {
    const result = collectValidatedPairs(cells)
    expect(result[0].source).toBe("God created the heavens")
    expect(result[1].source).toBe("In the beginning")
  })
})

// ---------------------------------------------------------------------------
// Living Memory: buildRulesBlock
// ---------------------------------------------------------------------------

describe("buildRulesBlock", () => {
  const makeRule = (id: string, check: TranslationRule["check"], enabled = true): TranslationRule => ({
    id, name: id, description: "", severity: "minor", source: "user", scope: "project",
    check, enabled, createdAt: new Date().toISOString(),
  })

  it("returns empty string when rules array is empty", () => {
    expect(buildRulesBlock([])).toBe("")
  })

  it("returns empty string when all rules are disabled", () => {
    const rule = makeRule("r1", { type: "target-forbids", targetPattern: "bienes" }, false)
    expect(buildRulesBlock([rule])).toBe("")
  })

  it("renders source-requires-target as 'if source contains X → target must include Y'", () => {
    const rule = makeRule("r1", { type: "source-requires-target", sourcePattern: "bienestar", targetPattern: "bienes" })
    const block = buildRulesBlock([rule])
    expect(block).toContain("bienestar")
    expect(block).toContain("bienes")
    expect(block).toMatch(/must include/i)
  })

  it("renders target-forbids rule", () => {
    const rule = makeRule("r1", { type: "target-forbids", targetPattern: "forbidden_word" })
    const block = buildRulesBlock([rule])
    expect(block).toContain("forbidden_word")
    expect(block).toMatch(/do not use/i)
  })

  it("renders source-target-match rule", () => {
    const rule = makeRule("r1", { type: "source-target-match", pattern: "Yahweh" })
    const block = buildRulesBlock([rule])
    expect(block).toContain("Yahweh")
  })

  it("skips builtin check type (no useful injection)", () => {
    const rule = makeRule("builtin:r1", { type: "builtin", checkId: "no-repeated-word" as TranslationRule["check"] extends { type: "builtin"; checkId: infer C } ? C : never })
    // builtin produces no lines → returns ""
    expect(buildRulesBlock([rule])).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Living Memory: rules + validatedPairs injected into buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt with rules and validatedPairs", () => {
  const rule: TranslationRule = {
    id: "r1", name: "bienestar→bienes", description: "", severity: "minor",
    source: "user", scope: "project", enabled: true, createdAt: new Date().toISOString(),
    check: { type: "source-requires-target", sourcePattern: "bienestar", targetPattern: "bienes" },
  }

  it("injects enabled rules into the system prompt", () => {
    const messages = buildPrompt({
      sourceLanguage: "Spanish", targetLanguage: "Tagalog",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "el bienestar del pueblo",
      examples: [], rules: [rule],
    })
    expect(messages[0].content).toContain("bienestar")
    expect(messages[0].content).toContain("bienes")
  })

  it("does NOT inject disabled rules", () => {
    const disabled = { ...rule, enabled: false }
    const messages = buildPrompt({
      sourceLanguage: "Spanish", targetLanguage: "Tagalog",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "x",
      examples: [], rules: [disabled],
    })
    expect(messages[0].content).not.toContain("bienestar")
  })

  it("prepends validatedPairs before search-retrieved examples", () => {
    const messages = buildPrompt({
      sourceLanguage: "Spanish", targetLanguage: "Tagalog",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "live source",
      examples: [{ source: "search result", target: "search target" }],
      validatedPairs: [{ source: "validated source", target: "validated target" }],
    })
    const user = messages[1].content
    const idxValidated = user.indexOf("validated source")
    const idxSearch = user.indexOf("search result")
    expect(idxValidated).toBeGreaterThan(-1)
    expect(idxSearch).toBeGreaterThan(idxValidated) // validated comes first
  })

  it("behaves identically to the old signature when no rules/validatedPairs passed", () => {
    const withoutMemory = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "hello",
      examples: [{ source: "God", target: "Dieu" }],
    })
    const withEmptyMemory = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "hello",
      examples: [{ source: "God", target: "Dieu" }],
      rules: [], validatedPairs: [],
    })
    expect(withoutMemory).toEqual(withEmptyMemory)
  })
})

// ---------------------------------------------------------------------------
// Living Memory: rules + validatedPairs injected into buildBatchPrompt
// ---------------------------------------------------------------------------

describe("buildBatchPrompt with rules and validatedPairs", () => {
  const rule: TranslationRule = {
    id: "r1", name: "bienestar→bienes", description: "", severity: "minor",
    source: "user", scope: "project", enabled: true, createdAt: new Date().toISOString(),
    check: { type: "source-requires-target", sourcePattern: "bienestar", targetPattern: "bienes" },
  }

  it("injects rules into the system prompt", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "Spanish", targetLanguage: "Tagalog",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "el bienestar" }],
      examples: [], rules: [rule],
    })
    expect(messages[0].content).toContain("bienestar")
  })

  it("prepends validatedPairs before passage examples in user message", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "live" }],
      examples: [{ cells: [{ source: "passage source", target: "passage target" }] }],
      validatedPairs: [{ source: "mem source", target: "mem target" }],
    })
    const user = messages[1].content
    const idxMem = user.indexOf("mem source")
    const idxPassage = user.indexOf("passage source")
    expect(idxMem).toBeGreaterThan(-1)
    expect(idxPassage).toBeGreaterThan(idxMem)
  })
})

// ---------------------------------------------------------------------------
// AQU-187: v1 AI retrieval-tuning settings defaults & top_k wiring
// ---------------------------------------------------------------------------

describe("CompletionSettings v1 retrieval fields", () => {
  it("FALLBACK_SETTINGS-style defaults: top_k=15, contextSize=medium, approved-only examples, main_chat_language empty", () => {
    const settings: CompletionSettings = {
      endpoint: "",
      model: "",
      maxTokens: 512,
      temperature: 0.3,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      // v1 defaults applied explicitly (mirrors FALLBACK_SETTINGS in useCompletion)
      top_k: 15,
      contextSize: "medium",
      useOnlyValidatedExamples: true,
      main_chat_language: "",
    }
    expect(settings.top_k).toBe(15)
    expect(settings.contextSize).toBe("medium")
    expect(settings.useOnlyValidatedExamples).toBe(true)
    expect(settings.main_chat_language).toBe("")
  })

  it("collectValidatedPairs respects top_k limit", () => {
    const cells = Array.from({ length: 10 }, (_, i) => ({
      status: "validated",
      original: `source ${i}`,
      translated: `target ${i}`,
    }))
    const topK = 3
    const result = collectValidatedPairs(cells, undefined, topK)
    expect(result).toHaveLength(topK)
  })

  it("collectValidatedPairs returns only validated cells", () => {
    const cells = [
      { status: "validated", original: "hello", translated: "hola" },
      { status: "draft", original: "world", translated: "mundo" },
      { status: "validated", original: "yes", translated: "sí" },
    ]
    const result = collectValidatedPairs(cells)
    expect(result).toHaveLength(2)
    expect(result.every((p) => p.source && p.target)).toBe(true)
  })
})

describe("DEFAULT_SYSTEM_PROMPT instruction steps", () => {
  it("contains the 7-step analysis→complete→consistency instruction sequence", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("1. Analyze the provided reference data")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("2. Complete the translation")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("3. Ensure your translation is consistent")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("4. Pay careful attention to the provided reference data")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("5. Translate only into {targetLanguage}")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("6. When unsure, err on the side of literalness")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("7. Preserve the line breaks")
  })

  it("retains language placeholders and output-only strictness", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("{sourceLanguage}")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("{targetLanguage}")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Output ONLY the {targetLanguage} translation")
    expect(DEFAULT_SYSTEM_PROMPT).toContain("No commentary")
  })

  it("emphasises ultra-low-resource language", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/ultra-low.resource language/i)
  })
})

describe("buildPrompt — target-only format", () => {
  it("omits 'Source:' lines for examples and renders only 'Target:'", () => {
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "In the beginning",
      examples: [{ source: "God created", target: "Dieu crea" }, { source: "the heavens", target: "les cieux" }],
      exampleFormat: "target-only",
    })
    expect(messages[1].content).not.toContain("Source: God created")
    expect(messages[1].content).not.toContain("Source: the heavens")
    expect(messages[1].content).toContain("Target: Dieu crea")
    expect(messages[1].content).toContain("Target: les cieux")
    // The live source is still present for the model to translate
    expect(messages[1].content).toContain("Source: In the beginning")
  })

  it("appends the reference-translation note to the system prompt", () => {
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "test",
      examples: [],
      exampleFormat: "target-only",
    })
    expect(messages[0].content).toContain("reference translations")
  })

  it("default (source-and-target) behavior is unchanged", () => {
    const messages = buildPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT, sourceText: "test",
      examples: [{ source: "God created", target: "Dieu crea" }],
    })
    expect(messages[1].content).toContain("Source: God created")
    expect(messages[1].content).toContain("Translation: Dieu crea")
    expect(messages[0].content).not.toContain("reference translations")
  })
})

describe("buildBatchPrompt — target-only format", () => {
  it("omits 'Source:' blocks for examples and renders only 'Translation:' target list", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "live cell" }],
      examples: [{ cells: [{ source: "Hello", target: "Bonjour" }, { source: "world", target: "monde" }] }],
      exampleFormat: "target-only",
    })
    // Example source block must be absent
    expect(messages[1].content).not.toContain("<v1>Hello</v1>")
    expect(messages[1].content).not.toContain("<v2>world</v2>")
    // Example target block must be present
    expect(messages[1].content).toContain("<v1>Bonjour</v1>")
    expect(messages[1].content).toContain("<v2>monde</v2>")
    // Live source must still appear
    expect(messages[1].content).toContain("<v1>live cell</v1>")
  })

  it("appends the reference-translation note to the system prompt", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "x" }], examples: [],
      exampleFormat: "target-only",
    })
    expect(messages[0].content).toContain("reference translations")
  })

  it("default (source-and-target) batch behavior is unchanged", () => {
    const messages = buildBatchPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ source: "live cell" }],
      examples: [{ cells: [{ source: "Hello", target: "Bonjour" }] }],
    })
    expect(messages[1].content).toContain("<v1>Hello</v1>")
    expect(messages[1].content).toContain("<v1>Bonjour</v1>")
    expect(messages[0].content).not.toContain("reference translations")
  })
})

describe("buildBriefBlock", () => {
  it("wraps a non-empty summary in a labeled block", () => {
    expect(buildBriefBlock("Translate for youth.")).toContain("Translation brief")
    expect(buildBriefBlock("Translate for youth.")).toContain("Translate for youth.")
  })
  it("returns empty string for blank input", () => {
    expect(buildBriefBlock("")).toBe("")
    expect(buildBriefBlock("   ")).toBe("")
  })
})

describe("buildPrompt with brief summary", () => {
  it("injects the brief block into the system message when present", () => {
    const [sys] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "X", systemPrompt: "Base.",
      sourceText: "logos", examples: [], briefSummary: "Prefer natural phrasing.",
    })
    expect(sys.content).toContain("Prefer natural phrasing.")
  })
  it("omits the brief block when absent", () => {
    const [sys] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "X", systemPrompt: "Base.",
      sourceText: "logos", examples: [],
    })
    expect(sys.content).not.toContain("Translation brief")
  })
})

describe("buildPrompt precedingContext (D4)", () => {
  it("renders preceding committed context after examples and just before the live source", () => {
    const [, user] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "Kala", systemPrompt: "X",
      sourceText: "LIVE_SRC",
      examples: [{ source: "EX_SRC", target: "EX_TGT" }],
      precedingContext: [{ source: "PREV_SRC", target: "PREV_TGT" }],
    })
    const c = user.content
    // example comes before preceding-context, which comes before the live source
    expect(c.indexOf("EX_SRC")).toBeLessThan(c.indexOf("PREV_SRC"))
    expect(c.indexOf("PREV_SRC")).toBeLessThan(c.indexOf("LIVE_SRC"))
    expect(c).toContain("PREV_TGT")
    expect(c.trimEnd().endsWith("LIVE_SRC\nTranslation:")).toBe(true)
  })

  it("omits empty/blank preceding pairs and works when absent", () => {
    const [, user] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "Kala", systemPrompt: "X",
      sourceText: "LIVE", examples: [],
      precedingContext: [{ source: "S", target: "  " }],
    })
    expect(user.content).not.toContain("\nTranslation:   \n")
  })
})

// ---------------------------------------------------------------------------
// buildParagraphPrompt (D3, D4, D11)
// ---------------------------------------------------------------------------

import { buildParagraphPrompt } from "./completion-service"

const ID_A = "aaaa-aaaa"
const ID_B = "bbbb-bbbb"

describe("buildParagraphPrompt", () => {
  it("appends a format-specific output contract to the system prompt", () => {
    const [system, user] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "<p data-idml-version=\"2\">protected</p>" }],
      examples: [],
      systemAddendum: "PRESERVE-IDML-ANCHORS",
    })
    expect(system.content).toContain("PRESERVE-IDML-ANCHORS")
    expect(user.content).not.toContain("PRESERVE-IDML-ANCHORS")
  })

  it("encodes source cells as <c id> tags in the user message (D11)", () => {
    const [, user] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [
        { cellId: ID_A, source: "In the beginning" },
        { cellId: ID_B, source: "God created" },
      ],
      examples: [],
    })
    expect(user.content).toContain(`<c id="${ID_A}">In the beginning</c>`)
    expect(user.content).toContain(`<c id="${ID_B}">God created</c>`)
  })

  it("system prompt instructs model to reply with <c id> tags (D11)", () => {
    const [sys] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "test" }],
      examples: [],
    })
    expect(sys.content).toContain("<c id=")
    expect(sys.content).toContain("CELL_ID")
  })

  it("injects preceding committed TARGET context before the live paragraph (D4)", () => {
    const [, user] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "LIVE_SRC" }],
      examples: [],
      precedingContext: [{ source: "PREV_SRC", target: "PREV_TGT" }],
    })
    const c = user.content
    // Preceding context appears BEFORE the live source paragraph
    expect(c.indexOf("PREV_TGT")).toBeGreaterThan(-1)
    expect(c.indexOf("PREV_SRC")).toBeLessThan(c.indexOf("LIVE_SRC"))
  })

  it("renders a blank-target preceding cell as source-only fallback, not a Translation pair (D4)", () => {
    const [, user] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "LIVE" }],
      examples: [],
      precedingContext: [
        { source: "COMMITTED_SRC", target: "COMMITTED_TGT" },
        { source: "UNCOMMITTED_SRC", target: "" },
      ],
    })
    const c = user.content
    // Committed cell renders as a Source/Translation pair.
    expect(c).toContain("Source: COMMITTED_SRC\nTranslation: COMMITTED_TGT")
    // Uncommitted cell appears as source-only discourse context — never a
    // (mimickable) Translation pair the model could copy as a blank answer.
    expect(c).toContain("Preceding (source, not yet translated): UNCOMMITTED_SRC")
    expect(c).not.toContain("UNCOMMITTED_SRC\nTranslation")
  })

  it("includes following source context labeled as context-only (D4 right side)", () => {
    const [, user] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "LIVE" }],
      examples: [],
      followingSource: [{ source: "NEXT_SRC" }],
    })
    expect(user.content).toContain("NEXT_SRC")
    expect(user.content).toContain("do not translate")
  })

  it("renders passage examples before preceding context and live paragraph", () => {
    const [, user] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "LIVE" }],
      examples: [{ cells: [{ source: "EX_SRC", target: "EX_TGT" }] }],
      precedingContext: [{ source: "PREV_SRC", target: "PREV_TGT" }],
    })
    const c = user.content
    expect(c.indexOf("EX_SRC")).toBeLessThan(c.indexOf("PREV_SRC"))
    expect(c.indexOf("PREV_SRC")).toBeLessThan(c.indexOf("LIVE"))
  })

  it("injects rules into the system prompt", () => {
    const rule: TranslationRule = {
      id: "r1", name: "r1", description: "", severity: "minor",
      source: "user", scope: "project", enabled: true, createdAt: new Date().toISOString(),
      check: { type: "target-forbids", targetPattern: "forbidden_word" },
    }
    const [sys] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "test" }],
      examples: [], rules: [rule],
    })
    expect(sys.content).toContain("forbidden_word")
  })

  it("injects brief summary into the system prompt", () => {
    const [sys] = buildParagraphPrompt({
      sourceLanguage: "English", targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      cells: [{ cellId: ID_A, source: "test" }],
      examples: [], briefSummary: "Prefer natural phrasing.",
    })
    expect(sys.content).toContain("Prefer natural phrasing.")
  })

  it("substitutes language placeholders and none remain in output", () => {
    const [sys] = buildParagraphPrompt({
      sourceLanguage: "Koine Greek", targetLanguage: "Kala",
      systemPrompt: "Translate {sourceLanguage} to {targetLanguage}.",
      cells: [{ cellId: ID_A, source: "logos" }],
      examples: [],
    })
    expect(sys.content).toContain("Koine Greek")
    expect(sys.content).toContain("Kala")
    expect(sys.content).not.toContain("{sourceLanguage}")
    expect(sys.content).not.toContain("{targetLanguage}")
  })

  // Coordinator adjudication (p1-paragraph-ui-wiring): a validated cell
  // skipped mid-group must not leave a silent gap — it renders IN POSITION
  // as a locked reference segment (source + its existing committed target),
  // never as a `<c id>` tag, so drafted neighbors don't read as artificially
  // contiguous.
  describe("locked segments (validated cells rendered in position)", () => {
    it("renders a locked cell's source + committed target in position, without a <c id> tag for it", () => {
      const ID_C = "cccc-cccc"
      const [, user] = buildParagraphPrompt({
        sourceLanguage: "English", targetLanguage: "French",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        cells: [
          { cellId: ID_A, source: "Verse one source" },
          { cellId: ID_B, source: "Verse two source", lockedTarget: "Verse two committed target" },
          { cellId: ID_C, source: "Verse three source" },
        ],
        examples: [],
      })
      // Locked cell renders in position, marked, with its committed target —
      // and is NOT wrapped in a <c id> tag.
      expect(user.content).toContain(
        "Verse two source [already translated — do not output: Verse two committed target]",
      )
      expect(user.content).not.toContain(`<c id="${ID_B}">`)
      // Its neighbors are still individually tagged as usual.
      expect(user.content).toContain(`<c id="${ID_A}">Verse one source</c>`)
      expect(user.content).toContain(`<c id="${ID_C}">Verse three source</c>`)
      // Order is preserved: A's tag, then the locked marker, then C's tag.
      const c = user.content
      expect(c.indexOf(`<c id="${ID_A}">`))
        .toBeLessThan(c.indexOf("Verse two committed target"))
      expect(c.indexOf("Verse two committed target"))
        .toBeLessThan(c.indexOf(`<c id="${ID_C}">`))
    })

    it("adds a system-prompt instruction not to tag or re-translate locked segments, only when one is present", () => {
      const [sysWithLocked] = buildParagraphPrompt({
        sourceLanguage: "English", targetLanguage: "French",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        cells: [{ cellId: ID_A, source: "test", lockedTarget: "déjà" }],
        examples: [],
      })
      expect(sysWithLocked.content).toContain("already translated")
      expect(sysWithLocked.content.toLowerCase()).toContain("do not")

      const [sysWithoutLocked] = buildParagraphPrompt({
        sourceLanguage: "English", targetLanguage: "French",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        cells: [{ cellId: ID_A, source: "test" }],
        examples: [],
      })
      expect(sysWithoutLocked.content).not.toContain("already translated")
    })
  })
})

describe("activeProjectIdFromPath", () => {
  // WHY: this is the single attribution point for chat credit spend (AQU-414
  // follow-up) — every completion caller runs on a project route, so the URL
  // defines "the project in scope". A wrong match here silently bills the
  // wrong org (or none), so the route shapes are pinned.
  it("extracts the id from /project/:id/editor and nested project routes", () => {
    expect(activeProjectIdFromPath("/project/abc-123/editor")).toBe("abc-123")
    expect(activeProjectIdFromPath("/project/abc-123/editor/file/f-9")).toBe("abc-123")
    expect(activeProjectIdFromPath("/project/abc-123/rules")).toBe("abc-123")
    expect(activeProjectIdFromPath("/projects/abc-123")).toBe("abc-123")
  })

  it("returns null off project surfaces so project-less chat stays at the no-org fallback", () => {
    expect(activeProjectIdFromPath("/")).toBeNull()
    expect(activeProjectIdFromPath("/preferences")).toBeNull()
    expect(activeProjectIdFromPath("/settings/ai")).toBeNull()
    // /projects/archived is a static list page, not a project id.
    expect(activeProjectIdFromPath("/projects/archived")).toBeNull()
  })
})
