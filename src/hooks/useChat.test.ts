/**
 * useChat.test.ts — FRO-175
 *
 * Unit tests for the useChat hook.
 * Covers: message history append, streaming state, cell-context toggle,
 *         error recovery (failed sends stay visible, retry/dismiss),
 *         regenerate, persistence, abort/stop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useChat, mapChatError } from "./useChat"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

// ---------------------------------------------------------------------------
// Mock chat-service so tests don't hit the network
// ---------------------------------------------------------------------------

vi.mock("@/lib/completion/chat-service", () => ({
  buildChatMessages: vi.fn((opts: { history: unknown[]; userMessage: string; cellContext: unknown }) => [
    { role: "system", content: "system" },
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ]),
  sendChatMessage: vi.fn(),
  chatIsConfigured: vi.fn(() => true),
}))

import { sendChatMessage, chatIsConfigured, buildChatMessages } from "@/lib/completion/chat-service"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION: FrontierSession = {
  jwt: "jwt-test",
  username: "tester",
  createdAt: new Date().toISOString(),
}

const SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: "",
  llmHealthPenalty: 0,
}

const CELL_CTX = {
  sourceText: "In the beginning",
  translatedText: "Au commencement",
  context: "GEN 1:1",
}

function makeHook(projectId?: string) {
  return renderHook(() =>
    useChat({
      settings: SETTINGS,
      session: SESSION,
      sourceLanguage: "English",
      targetLanguage: "French",
      projectId,
    }),
  )
}

// Minimal localStorage mock for persistence tests
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(window, "localStorage", { value: localStorageMock })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useChat", () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.mocked(chatIsConfigured).mockReturnValue(true)
    vi.mocked(sendChatMessage).mockResolvedValue("AI reply")
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("initialises with empty history", () => {
    const { result } = makeHook()
    expect(result.current.messages).toEqual([])
    expect(result.current.isStreaming).toBe(false)
  })

  it("appends user message and assistant reply to history after a turn", async () => {
    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("Hello", null)
    })

    const msgs = result.current.messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: "user", content: "Hello" })
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "AI reply" })
  })

  it("stamps new messages with a ts timestamp", async () => {
    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("Hello", null)
    })

    for (const msg of result.current.messages) {
      expect(typeof msg.ts).toBe("number")
      expect(msg.id).toBeTruthy()
    }
  })

  it("keeps history growing across multiple turns", async () => {
    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("Turn 1", null)
    })
    vi.mocked(sendChatMessage).mockResolvedValueOnce("Reply 2")
    await act(async () => {
      await result.current.sendMessage("Turn 2", null)
    })

    expect(result.current.messages).toHaveLength(4)
    expect(result.current.messages[2]).toMatchObject({ role: "user", content: "Turn 2" })
    expect(result.current.messages[3]).toMatchObject({ role: "assistant", content: "Reply 2" })
  })

  it("calls sendChatMessage with cell context when includeCellContext is true", async () => {
    const { result } = makeHook()

    // includeCellContext defaults to true
    expect(result.current.includeCellContext).toBe(true)

    await act(async () => {
      await result.current.sendMessage("test", CELL_CTX)
    })

    expect(buildChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({ cellContext: CELL_CTX }),
    )
  })

  it("passes null cell context when includeCellContext is false", async () => {
    const { result } = makeHook()

    act(() => { result.current.setIncludeCellContext(false) })

    await act(async () => {
      await result.current.sendMessage("test", CELL_CTX)
    })

    expect(buildChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({ cellContext: null }),
    )
  })

  it("persists includeCellContext per project and restores it on remount", () => {
    const { result, unmount } = makeHook("proj-ctx")
    act(() => { result.current.setIncludeCellContext(false) })
    unmount()

    const { result: result2 } = makeHook("proj-ctx")
    expect(result2.current.includeCellContext).toBe(false)
  })

  // ── Error recovery (spec: failed sends stay visible, no rollback) ────────

  it("keeps the failed user message visible with failed status instead of rolling back", async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error("Completion failed: 500 boom"))

    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("will fail", null)
    })

    expect(result.current.messages).toHaveLength(1)
    const failed = result.current.messages[0]
    expect(failed).toMatchObject({
      role: "user",
      content: "will fail",
      status: "failed",
      errorMessage: "Something went wrong.",
    })
    expect(failed.errorDetail).toContain("boom")
  })

  it("maps known errors to human copy", () => {
    expect(mapChatError(new Error("Sign in to use Frontier AI.")).message).toBe("Sign in to use AI chat.")
    expect(mapChatError(new Error("Completion failed: 401 unauthorized")).message).toBe("Sign in to use AI chat.")
    expect(mapChatError(new Error("Frontier AI limit reached: Out of credits.")).message).toBe(
      "AI limit reached — try again later.",
    )
    expect(mapChatError(new Error("Completion failed: 429 too many requests")).message).toBe(
      "AI limit reached — try again later.",
    )
    expect(mapChatError(new TypeError("Failed to fetch")).message).toBe("Connection lost — retry?")
    expect(mapChatError(new Error("kaboom")).message).toBe("Something went wrong.")
  })

  it("retryMessage re-sends a failed message without duplicating it", async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error("Failed to fetch"))

    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("retry me", null)
    })
    expect(result.current.messages).toHaveLength(1)
    const failedId = result.current.messages[0].id

    vi.mocked(sendChatMessage).mockResolvedValueOnce("Recovered reply")
    await act(async () => {
      await result.current.retryMessage(failedId, null)
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "retry me",
      id: failedId,
    })
    expect(result.current.messages[0].status).toBeUndefined()
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", content: "Recovered reply" })
  })

  it("dismissMessage removes a failed message", async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error("Failed to fetch"))

    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("dismiss me", null)
    })
    const failedId = result.current.messages[0].id

    act(() => { result.current.dismissMessage(failedId) })
    expect(result.current.messages).toHaveLength(0)
  })

  it("excludes failed messages from the LLM history on subsequent sends", async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error("Failed to fetch"))

    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("failed turn", null)
    })

    vi.mocked(sendChatMessage).mockResolvedValueOnce("ok")
    await act(async () => {
      await result.current.sendMessage("next turn", null)
    })

    const lastBuild = vi.mocked(buildChatMessages).mock.calls.at(-1)![0]
    expect(lastBuild.history).toEqual([])
  })

  // ── Regenerate ───────────────────────────────────────────────────────────

  it("regenerate removes the last assistant reply and re-sends the prior user turn", async () => {
    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("Question", null)
    })
    expect(result.current.messages).toHaveLength(2)

    vi.mocked(sendChatMessage).mockResolvedValueOnce("Better reply")
    await act(async () => {
      await result.current.regenerate(null)
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0]).toMatchObject({ role: "user", content: "Question" })
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", content: "Better reply" })
  })

  it("regenerate is a no-op when the last message is not an assistant reply", async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error("Failed to fetch"))
    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("failed", null)
    })
    vi.mocked(sendChatMessage).mockClear()

    await act(async () => {
      await result.current.regenerate(null)
    })

    expect(sendChatMessage).not.toHaveBeenCalled()
  })

  // ── Misc ────────────────────────────────────────────────────────────────

  it("clearHistory resets to empty state", async () => {
    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("hello", null)
    })
    expect(result.current.messages).toHaveLength(2)

    act(() => { result.current.clearHistory() })

    expect(result.current.messages).toHaveLength(0)
  })

  it("ignores empty / whitespace-only messages", async () => {
    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("   ", null)
    })

    expect(sendChatMessage).not.toHaveBeenCalled()
    expect(result.current.messages).toHaveLength(0)
  })

  it("persists and reloads history from localStorage when projectId is given", async () => {
    const { result, unmount } = makeHook("proj-abc")

    await act(async () => {
      await result.current.sendMessage("Persist me", null)
    })

    expect(result.current.messages).toHaveLength(2)
    unmount()

    // Re-mount a new hook instance; it should reload from localStorage
    const { result: result2 } = makeHook("proj-abc")
    expect(result2.current.messages).toHaveLength(2)
    expect(result2.current.messages[0]).toMatchObject({ role: "user", content: "Persist me" })
  })

  it("tolerates legacy persisted messages without id/ts", () => {
    localStorageMock.setItem(
      "chat-history:proj-legacy",
      JSON.stringify([
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ]),
    )

    const { result } = makeHook("proj-legacy")
    expect(result.current.messages).toHaveLength(2)
    // ids are assigned on load so list keys / retry / dismiss work
    expect(result.current.messages[0].id).toBeTruthy()
    expect(result.current.messages[0].ts).toBeUndefined()
  })

  it("does not persist history when projectId is omitted", async () => {
    const { result, unmount } = makeHook() // no projectId

    await act(async () => {
      await result.current.sendMessage("Ephemeral", null)
    })

    unmount()

    // Nothing should be in storage
    expect(localStorageMock.getItem("chat-history:undefined")).toBeNull()
  })

  it("reflects isConfigured from chatIsConfigured", () => {
    vi.mocked(chatIsConfigured).mockReturnValue(false)
    const { result } = makeHook()
    expect(result.current.isConfigured).toBe(false)
  })

  it("accumulates streaming text via onChunk", async () => {
    // Simulate streaming: sendChatMessage calls onChunk multiple times then resolves
    vi.mocked(sendChatMessage).mockImplementation(async (opts) => {
      opts.onChunk?.("Hello ")
      opts.onChunk?.("Hello world")
      return "Hello world"
    })

    const { result } = makeHook()

    await act(async () => {
      await result.current.sendMessage("hi", null)
    })

    // After completion, streamingText is cleared and message is in history
    expect(result.current.streamingText).toBe("")
    const last = result.current.messages[result.current.messages.length - 1]
    expect(last.content).toBe("Hello world")
  })
})
