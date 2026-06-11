/**
 * useChat.ts — FRO-175
 *
 * React hook for the workspace AI chat panel.
 *
 * Manages conversation history, streaming state, and the cell-context toggle.
 * Delegates all LLM calls to chat-service.ts (which reuses completion-service.ts).
 *
 * Chat UX improvements (spec: docs/superpowers/specs/chat-ux-improvements.md):
 *  - Failed sends stay visible in the list (status: "failed") with retry/dismiss
 *    instead of rolling back the user's typed message.
 *  - Regenerate removes the last assistant reply and re-sends the prior turn.
 *  - `includeCellContext` persists per project in localStorage.
 *  - New messages carry a `ts` timestamp (legacy persisted entries may lack it).
 */

import { useState, useCallback, useRef, useEffect } from "react"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import {
  buildChatMessages,
  sendChatMessage,
  chatIsConfigured,
  type ChatMessage,
  type CellContext,
} from "@/lib/completion/chat-service"

export type { ChatMessage, CellContext }

/** UI-side chat message — chat-service's wire shape plus presentation fields. */
export interface UiChatMessage extends ChatMessage {
  /** Stable identity for retry/dismiss/list keys. */
  id: string
  /** Epoch ms. Legacy persisted messages may lack it — render nothing then. */
  ts?: number
  /** "failed" = the send never reached the model; retryable. */
  status?: "failed"
  /** Human copy for the failure (mapped from the raw error). */
  errorMessage?: string
  /** Raw error detail, shown behind a disclosure. */
  errorDetail?: string
}

export interface UseChatOptions {
  settings: CompletionSettings | undefined
  session: FrontierSession | null
  sourceLanguage: string
  targetLanguage: string
  /** Name of the file currently open in the editor, included as chat context. */
  currentFileName?: string
  /**
   * Project identifier used to scope chat history persistence.
   * If omitted, history is in-memory only (not persisted).
   */
  projectId?: string
}

// ── Error mapping ─────────────────────────────────────────────────────────

/** Map raw send errors to human copy (raw detail preserved separately). */
export function mapChatError(err: unknown): { message: string; detail: string } {
  const raw = err instanceof Error ? err.message : String(err)
  if (/\b401\b|sign in/i.test(raw)) {
    return { message: "Sign in to use AI chat.", detail: raw }
  }
  if (/\b402\b|\b429\b|limit reached|out of credits|rate limit/i.test(raw)) {
    return { message: "AI limit reached — try again later.", detail: raw }
  }
  if (err instanceof TypeError || /failed to fetch|network|connection/i.test(raw)) {
    return { message: "Connection lost — retry?", detail: raw }
  }
  return { message: "Something went wrong.", detail: raw }
}

// ── localStorage persistence helpers ─────────────────────────────────────

const MAX_PERSISTED_MESSAGES = 200

function storageKey(projectId: string): string {
  return `chat-history:${projectId}`
}

function contextKey(projectId: string): string {
  return `chat-include-cell-context:${projectId}`
}

function newId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function loadHistory(projectId: string | undefined): UiChatMessage[] {
  if (!projectId || typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(storageKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Legacy entries lack `id` — assign one so list keys/actions work.
    return (parsed as UiChatMessage[]).map((m) => (m.id ? m : { ...m, id: newId() }))
  } catch {
    return []
  }
}

function saveHistory(projectId: string | undefined, messages: UiChatMessage[]): void {
  if (!projectId || typeof window === "undefined") return
  try {
    const trimmed = messages.slice(-MAX_PERSISTED_MESSAGES)
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(trimmed))
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

function loadIncludeCellContext(projectId: string | undefined): boolean {
  if (!projectId || typeof window === "undefined") return true
  try {
    const raw = window.localStorage.getItem(contextKey(projectId))
    return raw === null ? true : raw === "true"
  } catch {
    return true
  }
}

export interface UseChatReturn {
  messages: UiChatMessage[]
  /** Streaming text of the in-progress assistant reply (empty when idle). */
  streamingText: string
  isStreaming: boolean
  /** Whether the cell-context toggle is on. */
  includeCellContext: boolean
  setIncludeCellContext: (v: boolean) => void
  isConfigured: boolean
  sendMessage: (userText: string, cellContext: CellContext | null) => Promise<void>
  /** Re-send a failed message (keeps it in place, no duplicate). */
  retryMessage: (id: string, cellContext: CellContext | null) => Promise<void>
  /** Remove a failed message from the list. */
  dismissMessage: (id: string) => void
  /** Remove the last assistant reply and re-send the preceding user turn. */
  regenerate: (cellContext: CellContext | null) => Promise<void>
  stopStreaming: () => void
  clearHistory: () => void
}

export function useChat(options: UseChatOptions): UseChatReturn {
  const { settings, session, sourceLanguage, targetLanguage, currentFileName, projectId } = options

  const [messages, setMessages] = useState<UiChatMessage[]>(() => loadHistory(projectId))
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [includeCellContext, setIncludeCellContextState] = useState(() =>
    loadIncludeCellContext(projectId),
  )

  const setIncludeCellContext = useCallback(
    (v: boolean) => {
      setIncludeCellContextState(v)
      if (projectId && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(contextKey(projectId), String(v))
        } catch {
          // Storage unavailable — state still works for this session.
        }
      }
    },
    [projectId],
  )

  // Persist history whenever messages change.
  useEffect(() => {
    saveHistory(projectId, messages)
  }, [projectId, messages])

  // AbortController for the in-flight request.
  const abortRef = useRef<AbortController | null>(null)

  const isConfigured = chatIsConfigured(settings, session)

  /**
   * Core send: appends (or re-marks) the user message on top of `base`,
   * streams the reply, and on failure keeps the user message visible with
   * a failed status instead of rolling it back.
   */
  const performSend = useCallback(
    async (base: UiChatMessage[], userMsg: UiChatMessage, cellContext: CellContext | null) => {
      // Abort any previous in-flight call (shouldn't happen, but safe).
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)
      setStreamingText("")

      const historyWithUser = [...base, userMsg]
      setMessages(historyWithUser)

      // Build the LLM message list: system + prior turns + the new user turn.
      // Failed sends never reached the model — exclude them. Strip UI-only
      // fields so the wire payload stays {role, content}.
      const llmHistory: ChatMessage[] = base
        .filter((m) => m.status !== "failed")
        .map((m) => ({ role: m.role, content: m.content }))
      const llmMessages = buildChatMessages({
        history: llmHistory,
        userMessage: userMsg.content,
        cellContext: includeCellContext ? cellContext : null,
        sourceLanguage,
        targetLanguage,
        fileName: currentFileName,
      })

      let accumulated = ""

      try {
        const reply = await sendChatMessage({
          settings,
          session,
          messages: llmMessages,
          onChunk: (text) => {
            accumulated = text
            setStreamingText(text)
          },
          signal: controller.signal,
        })

        // Use whatever we got (streaming accumulated or non-streaming reply).
        const finalText = reply || accumulated
        const assistantMsg: UiChatMessage = {
          id: newId(),
          role: "assistant",
          content: finalText,
          ts: Date.now(),
        }
        setMessages([...historyWithUser, assistantMsg])
        setStreamingText("")
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User stopped — commit whatever streamed so far.
          if (accumulated) {
            const assistantMsg: UiChatMessage = {
              id: newId(),
              role: "assistant",
              content: accumulated + " [stopped]",
              ts: Date.now(),
            }
            setMessages([...historyWithUser, assistantMsg])
          }
          setStreamingText("")
        } else {
          // Keep the user's message visible, marked failed, with retry.
          const { message, detail } = mapChatError(err)
          setMessages([
            ...base,
            { ...userMsg, status: "failed", errorMessage: message, errorDetail: detail },
          ])
          setStreamingText("")
        }
      } finally {
        setIsStreaming(false)
        abortRef.current = null
      }
    },
    [settings, session, sourceLanguage, targetLanguage, includeCellContext, currentFileName],
  )

  const sendMessage = useCallback(
    async (userText: string, cellContext: CellContext | null) => {
      const trimmed = userText.trim()
      if (!trimmed || isStreaming) return
      const userMsg: UiChatMessage = { id: newId(), role: "user", content: trimmed, ts: Date.now() }
      await performSend(messages, userMsg, cellContext)
    },
    [messages, isStreaming, performSend],
  )

  const retryMessage = useCallback(
    async (id: string, cellContext: CellContext | null) => {
      if (isStreaming) return
      const idx = messages.findIndex((m) => m.id === id && m.status === "failed")
      if (idx === -1) return
      const failed = messages[idx]
      // Re-send in place: same id/content, cleared failure state, fresh ts.
      const retryMsg: UiChatMessage = { id: failed.id, role: "user", content: failed.content, ts: Date.now() }
      const base = [...messages.slice(0, idx), ...messages.slice(idx + 1)]
      await performSend(base, retryMsg, cellContext)
    },
    [messages, isStreaming, performSend],
  )

  const dismissMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const regenerate = useCallback(
    async (cellContext: CellContext | null) => {
      if (isStreaming) return
      const last = messages[messages.length - 1]
      if (!last || last.role !== "assistant") return
      // Find the user turn that produced the last assistant reply.
      let userIdx = -1
      for (let i = messages.length - 2; i >= 0; i--) {
        if (messages[i].role === "user" && messages[i].status !== "failed") {
          userIdx = i
          break
        }
      }
      if (userIdx === -1) return
      const userMsg = messages[userIdx]
      const base = messages.slice(0, userIdx)
      const resend: UiChatMessage = { id: userMsg.id, role: "user", content: userMsg.content, ts: Date.now() }
      await performSend(base, resend, cellContext)
    },
    [messages, isStreaming, performSend],
  )

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clearHistory = useCallback(() => {
    abortRef.current?.abort()
    setMessages([])
    setStreamingText("")
    setIsStreaming(false)
  }, [])

  return {
    messages,
    streamingText,
    isStreaming,
    includeCellContext,
    setIncludeCellContext,
    isConfigured,
    sendMessage,
    retryMessage,
    dismissMessage,
    regenerate,
    stopStreaming,
    clearHistory,
  }
}
