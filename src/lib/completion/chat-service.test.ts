/**
 * chat-service.test.ts — FRO-175
 *
 * Unit tests for the workspace AI chat service.
 * Covers: buildChatMessages, chatIsConfigured, sendChatMessage (mocked fetch).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  buildChatMessages,
  chatIsConfigured,
  sendChatMessage,
  type CellContext,
} from "./chat-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION: FrontierSession = {
  jwt: "jwt-test",
  username: "tester",
  createdAt: new Date().toISOString(),
}

const FRONTIER_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: "",
  llmHealthPenalty: 0,
}

const CUSTOM_SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "http://localhost:8000",
  model: "llama3",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: "",
  llmHealthPenalty: 0,
}

const CELL_CTX: CellContext = {
  sourceText: "In the beginning God created the heavens and the earth.",
  translatedText: "Au commencement, Dieu créa les cieux et la terre.",
  context: "GEN 1:1",
}

// ---------------------------------------------------------------------------
// buildChatMessages
// ---------------------------------------------------------------------------

describe("buildChatMessages", () => {
  it("includes system message as first message", () => {
    const msgs = buildChatMessages({
      history: [],
      userMessage: "What does this mean?",
      cellContext: null,
      sourceLanguage: "English",
      targetLanguage: "French",
    })
    expect(msgs[0].role).toBe("system")
    expect(msgs[0].content).toContain("English")
    expect(msgs[0].content).toContain("French")
  })

  it("appends user message as last message", () => {
    const msgs = buildChatMessages({
      history: [],
      userMessage: "What does this mean?",
      cellContext: null,
      sourceLanguage: "English",
      targetLanguage: "French",
    })
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe("user")
    expect(last.content).toBe("What does this mean?")
  })

  it("includes cell context in system message when provided", () => {
    const msgs = buildChatMessages({
      history: [],
      userMessage: "Explain the source",
      cellContext: CELL_CTX,
      sourceLanguage: "English",
      targetLanguage: "French",
    })
    const sys = msgs[0]
    expect(sys.content).toContain("In the beginning God created")
    expect(sys.content).toContain("GEN 1:1")
    expect(sys.content).toContain("Au commencement")
  })

  it("does NOT include cell context in system message when cellContext is null", () => {
    const msgs = buildChatMessages({
      history: [],
      userMessage: "General question",
      cellContext: null,
      sourceLanguage: "English",
      targetLanguage: "French",
    })
    expect(msgs[0].content).not.toContain("Current cell")
  })

  it("preserves conversation history between system and new user message", () => {
    const history = [
      { role: "user" as const, content: "First question" },
      { role: "assistant" as const, content: "First answer" },
    ]
    const msgs = buildChatMessages({
      history,
      userMessage: "Follow-up",
      cellContext: null,
      sourceLanguage: "English",
      targetLanguage: "French",
    })
    // Order: system, user-1, assistant-1, user-new
    expect(msgs).toHaveLength(4)
    expect(msgs[0].role).toBe("system")
    expect(msgs[1].content).toBe("First question")
    expect(msgs[2].content).toBe("First answer")
    expect(msgs[3].content).toBe("Follow-up")
  })

  it("includes source and target language in system message", () => {
    const msgs = buildChatMessages({
      history: [],
      userMessage: "test",
      cellContext: null,
      sourceLanguage: "Swahili",
      targetLanguage: "Bambara",
    })
    expect(msgs[0].content).toContain("Swahili")
    expect(msgs[0].content).toContain("Bambara")
  })
})

// ---------------------------------------------------------------------------
// chatIsConfigured
// ---------------------------------------------------------------------------

describe("chatIsConfigured", () => {
  it("returns true for frontier provider when JWT is present", () => {
    expect(chatIsConfigured(FRONTIER_SETTINGS, SESSION)).toBe(true)
  })

  it("returns false for frontier provider when no JWT", () => {
    expect(chatIsConfigured(FRONTIER_SETTINGS, null)).toBe(false)
  })

  it("returns true for custom provider when endpoint + model present", () => {
    expect(chatIsConfigured(CUSTOM_SETTINGS, null)).toBe(true)
  })

  it("returns false for custom provider when no endpoint", () => {
    const noEndpoint: CompletionSettings = { ...CUSTOM_SETTINGS, endpoint: "" }
    expect(chatIsConfigured(noEndpoint, null)).toBe(false)
  })

  it("returns false for custom provider when no model", () => {
    const noModel: CompletionSettings = { ...CUSTOM_SETTINGS, model: "" }
    expect(chatIsConfigured(noModel, null)).toBe(false)
  })

  it("falls back to frontier check when settings is undefined", () => {
    // undefined settings → frontier default → needs JWT
    expect(chatIsConfigured(undefined, SESSION)).toBe(true)
    expect(chatIsConfigured(undefined, null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sendChatMessage — mocked fetch
// ---------------------------------------------------------------------------

describe("sendChatMessage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns the assistant reply text (non-streaming)", async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello from AI" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    const result = await sendChatMessage({
      settings: CUSTOM_SETTINGS,
      session: null,
      messages: [{ role: "user", content: "Hello" }],
    })

    expect(result).toBe("Hello from AI")
  })

  it("accumulates streamed chunks via onChunk callback", async () => {
    const mockFetch = vi.mocked(fetch)

    // Simulate an SSE stream: two data chunks + [DONE]
    const encoder = new TextEncoder()
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n`,
      "data: [DONE]\n",
    ]
    let chunkIdx = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (chunkIdx < chunks.length) {
          ctrl.enqueue(encoder.encode(chunks[chunkIdx++]))
        } else {
          ctrl.close()
        }
      },
    })

    mockFetch.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    const received: string[] = []
    const result = await sendChatMessage({
      settings: CUSTOM_SETTINGS,
      session: null,
      messages: [{ role: "user", content: "Hi" }],
      onChunk: (text) => received.push(text),
    })

    expect(result).toBe("Hello world")
    // onChunk was called at least once with the accumulated text
    expect(received.length).toBeGreaterThan(0)
    expect(received[received.length - 1]).toContain("Hello")
  })

  it("throws when the server returns a non-OK status", async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    )

    await expect(
      sendChatMessage({
        settings: CUSTOM_SETTINGS,
        session: null,
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow()
  })

  it("is abortable via AbortSignal", async () => {
    const mockFetch = vi.mocked(fetch)
    const controller = new AbortController()

    // Simulate fetch rejecting with AbortError when signal is aborted
    controller.abort()
    mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))

    const promise = sendChatMessage({
      settings: CUSTOM_SETTINGS,
      session: null,
      messages: [{ role: "user", content: "test" }],
      signal: controller.signal,
    })

    await expect(promise).rejects.toThrow()
  })
})
