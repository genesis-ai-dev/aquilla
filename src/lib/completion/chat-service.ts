/**
 * chat-service.ts — FRO-175
 *
 * Workspace AI chat panel — LLM plumbing.
 *
 * Reuses the same `complete()` call and `CompletionSettings`/`FrontierSession`
 * resolution that the inline-completion path uses (completion-service.ts).
 * No new auth/provider logic; just a different message shape.
 */

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { complete, resolveProvider } from "./completion-service"
import { cellTextForDisplay } from "@/lib/cell-text"
import { getUserProviderOverride } from "@/lib/store/user-provider-override"

// ── Types ──────────────────────────────────────────────────────────────────

export type ChatRole = "system" | "user" | "assistant"

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface CellContext {
  sourceText: string
  translatedText: string
  /** Human-readable location label, e.g. "GEN 1:1" */
  context?: string
}

// ── System prompt ──────────────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT =
  "You are a helpful translation assistant for a Bible/Scripture translation project. " +
  "You answer questions about source meaning, exegetical notes, translation choices, and general translation strategy. " +
  "Be concise, clear, and ground your answers in the text and examples provided."

// ── Cell-context injection ─────────────────────────────────────────────────

/**
 * Build the full message list for a chat turn, optionally prepending a
 * cell-context block so the model can ground its reply in the focused cell.
 */
export function buildChatMessages(options: {
  history: ChatMessage[]
  userMessage: string
  cellContext: CellContext | null
  sourceLanguage: string
  targetLanguage: string
  /** Name of the file open in the editor, if any. */
  fileName?: string
}): ChatMessage[] {
  const { history, userMessage, cellContext, sourceLanguage, targetLanguage, fileName } = options

  let systemContent = CHAT_SYSTEM_PROMPT
  systemContent += `\n\nProject languages: source = ${sourceLanguage || "unknown"}, target = ${targetLanguage || "unknown"}.`

  if (fileName) {
    systemContent += `\nThe user currently has the file "${fileName}" open in the editor.`
  }

  if (cellContext) {
    const sourceText = cellTextForDisplay(cellContext.sourceText)
    const translatedText = cellTextForDisplay(cellContext.translatedText)
    systemContent +=
      `\n\nCurrent cell (for context):\n` +
      (sourceText ? `  Source: ${sourceText}\n` : "") +
      (translatedText ? `  Current translation: ${translatedText}\n` : "") +
      (cellContext.context ? `  Reference: ${cellContext.context}\n` : "")
  }

  const systemMessage: ChatMessage = { role: "system", content: systemContent }

  // Keep the full history so multi-turn works correctly. Prepend system,
  // then history, then the new user turn.
  return [
    systemMessage,
    ...history,
    { role: "user", content: userMessage },
  ]
}

// ── isConfigured / isAvailable helpers ────────────────────────────────────

/**
 * True when the user has done the one-time setup required to use the LLM.
 * Mirrors the logic in useCompletion so chat uses the same gate.
 */
export function chatIsConfigured(
  settings: CompletionSettings | undefined,
  session: FrontierSession | null,
): boolean {
  const override = getUserProviderOverride()

  if (!settings && !override) return Boolean(session?.jwt) // frontier default

  const effectiveEndpoint = override?.endpoint ?? settings?.endpoint ?? ""
  const effectiveModel = override?.model || settings?.model || ""
  const effectiveProvider = override
    ? "custom"
    : settings
      ? resolveProvider(settings)
      : "frontier"

  if (effectiveProvider === "frontier") return Boolean(session?.jwt)
  return Boolean(effectiveEndpoint && effectiveModel)
}

// ── sendChatMessage ────────────────────────────────────────────────────────

export interface SendChatOptions {
  settings: CompletionSettings | undefined
  session: FrontierSession | null
  messages: ChatMessage[]
  onChunk?: (accumulated: string) => void
  signal?: AbortSignal
}

/**
 * Send one chat turn to the configured LLM endpoint.
 * Returns the assistant's full reply text.
 *
 * Uses `complete()` from completion-service so all provider/auth resolution
 * is shared — no duplication.
 */
export async function sendChatMessage(options: SendChatOptions): Promise<string> {
  const { settings, session, messages, onChunk, signal } = options

  // Fall back to frontier defaults when no settings are configured.
  const effectiveSettings: CompletionSettings = settings ?? {
    provider: "frontier",
    endpoint: "",
    model: "",
    maxTokens: 1024,
    temperature: 0.5,
    systemPrompt: "",
    llmHealthPenalty: 0,
  }

  return complete({
    settings: effectiveSettings,
    session,
    messages,
    stream: true,
    onChunk,
    signal,
  })
}
