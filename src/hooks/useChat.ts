/**
 * useChat.ts — FRO-175
 *
 * React hook for the workspace AI chat panel.
 *
 * Manages conversation history, streaming state, and the cell-context toggle.
 * Delegates all LLM calls to chat-service.ts (which reuses completion-service.ts).
 */

import { useState, useCallback, useRef } from "react"
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

export interface UseChatOptions {
  settings: CompletionSettings | undefined
  session: FrontierSession | null
  sourceLanguage: string
  targetLanguage: string
}

export interface UseChatReturn {
  messages: ChatMessage[]
  /** Streaming text of the in-progress assistant reply (empty when idle). */
  streamingText: string
  isStreaming: boolean
  error: string | null
  /** Whether the cell-context toggle is on. */
  includeCellContext: boolean
  setIncludeCellContext: (v: boolean) => void
  isConfigured: boolean
  sendMessage: (userText: string, cellContext: CellContext | null) => Promise<void>
  stopStreaming: () => void
  clearHistory: () => void
}

export function useChat(options: UseChatOptions): UseChatReturn {
  const { settings, session, sourceLanguage, targetLanguage } = options

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [includeCellContext, setIncludeCellContext] = useState(true)

  // AbortController for the in-flight request.
  const abortRef = useRef<AbortController | null>(null)

  const isConfigured = chatIsConfigured(settings, session)

  const sendMessage = useCallback(
    async (userText: string, cellContext: CellContext | null) => {
      const trimmed = userText.trim()
      if (!trimmed || isStreaming) return

      // Abort any previous in-flight call (shouldn't happen, but safe).
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setError(null)
      setIsStreaming(true)
      setStreamingText("")

      // Append the user message optimistically.
      const userMsg: ChatMessage = { role: "user", content: trimmed }
      const historyWithUser = [...messages, userMsg]
      setMessages(historyWithUser)

      // Build the full message list for the LLM (system + history + user turn).
      // We pass `history` WITHOUT the new user message since buildChatMessages
      // appends userMessage itself.
      const llmMessages = buildChatMessages({
        history: messages,
        userMessage: trimmed,
        cellContext: includeCellContext ? cellContext : null,
        sourceLanguage,
        targetLanguage,
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
        const assistantMsg: ChatMessage = { role: "assistant", content: finalText }
        setMessages([...historyWithUser, assistantMsg])
        setStreamingText("")
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User stopped — commit whatever streamed so far.
          if (accumulated) {
            const assistantMsg: ChatMessage = { role: "assistant", content: accumulated + " [stopped]" }
            setMessages([...historyWithUser, assistantMsg])
          }
          setStreamingText("")
        } else {
          const msg = err instanceof Error ? err.message : "Chat request failed"
          setError(msg)
          // Rollback the optimistic user message on hard failure.
          setMessages(messages)
          setStreamingText("")
        }
      } finally {
        setIsStreaming(false)
        abortRef.current = null
      }
    },
    [messages, isStreaming, settings, session, sourceLanguage, targetLanguage, includeCellContext],
  )

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clearHistory = useCallback(() => {
    abortRef.current?.abort()
    setMessages([])
    setStreamingText("")
    setError(null)
    setIsStreaming(false)
  }, [])

  return {
    messages,
    streamingText,
    isStreaming,
    error,
    includeCellContext,
    setIncludeCellContext,
    isConfigured,
    sendMessage,
    stopStreaming,
    clearHistory,
  }
}
