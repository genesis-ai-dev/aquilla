import type { CompletionSettings, CompletionProvider } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { resolveApiKey } from "@/lib/store/user-api-keys"
import { getUserProviderOverride } from "@/lib/store/user-provider-override"

export const DEFAULT_SYSTEM_PROMPT =
  "You are translating a project from {sourceLanguage} into {targetLanguage}.\n" +
  "Match the tone and formality of the provided examples. Return only the translated text — no explanations, no source text, no commentary."

// Honor VITE_FRONTIER_BASE override so the E2E suite can redirect chat
// completion calls to a local wrangler dev instance. See src/lib/frontier/auth.ts
// for the same pattern.
const FRONTIER_BASE_OVERRIDE =
  ((import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")) || ""
export const FRONTIER_CHAT_URL = `${FRONTIER_BASE_OVERRIDE || "https://api.frontierrnd.com"}/api/v1/chat/completions`

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/**
 * Pre-migration CompletionSettings records don't have `provider` set.
 * Infer: empty endpoint → "frontier" (new default); populated → "custom"
 * (preserves existing self-hosted/local setups). Saved-through on next write.
 */
export function resolveProvider(settings: CompletionSettings): CompletionProvider {
  if (settings.provider) return settings.provider
  return settings.endpoint.trim() ? "custom" : "frontier"
}

export function buildPrompt(options: {
  sourceLanguage: string; targetLanguage: string; systemPrompt: string
  sourceText: string; examples: { source: string; target: string }[]
}): ChatMessage[] {
  const sys = options.systemPrompt
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  let user = ""
  for (const ex of options.examples) user += `Source: ${ex.source}\nTranslation: ${ex.target}\n\n`
  user += `Source: ${options.sourceText}\nTranslation:`

  return [{ role: "system", content: sys }, { role: "user", content: user.trim() }]
}

/**
 * Normalize a user-supplied OpenAI-compatible base URL into endpoints for
 * `/chat/completions` and `/models`. Accepts:
 *   - "http://localhost:8000"                          (we append /v1/...)
 *   - "https://openrouter.ai/api/v1"                   (already has /v1)
 *   - "https://openrouter.ai/api/v1/chat/completions"  (full chat URL)
 * Trailing slashes are ignored.
 */
export function normalizeOpenAIBaseUrl(endpoint: string): { chatUrl: string; modelsUrl: string } {
  const trimmed = endpoint.trim().replace(/\/+$/, "")
  if (trimmed.endsWith("/chat/completions")) {
    const base = trimmed.slice(0, -"/chat/completions".length)
    return { chatUrl: trimmed, modelsUrl: `${base}/models` }
  }
  if (/\/v\d+$/.test(trimmed)) {
    return { chatUrl: `${trimmed}/chat/completions`, modelsUrl: `${trimmed}/models` }
  }
  return { chatUrl: `${trimmed}/v1/chat/completions`, modelsUrl: `${trimmed}/v1/models` }
}

export async function fetchModels(endpoint: string, apiKey?: string): Promise<string[]> {
  const { modelsUrl } = normalizeOpenAIBaseUrl(endpoint)
  const headers: Record<string, string> = {}
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
  const res = await fetch(modelsUrl, { headers })
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status} ${res.statusText}`)
  const data = await res.json()
  return data.data.map((m: { id: string }) => m.id)
}

export interface CompleteOptions {
  settings: CompletionSettings
  session: FrontierSession | null
  messages: ChatMessage[]
  stream?: boolean
  onChunk?: (text: string) => void
}

export async function complete(options: CompleteOptions): Promise<string> {
  // Personal per-device override (set in user Settings) takes precedence over
  // the project's completionSettings. This is the "advanced" path: the user
  // wants their own endpoint/key for everything they translate on this device.
  const override = getUserProviderOverride()
  const effectiveSettings: CompletionSettings = override
    ? {
        ...options.settings,
        provider: "custom",
        endpoint: override.endpoint,
        model: override.model || options.settings.model,
        apiKey: override.apiKey,
      }
    : options.settings
  const provider = resolveProvider(effectiveSettings)
  const { url, headers } = await buildRequestTarget(provider, effectiveSettings, options.session)

  // The Frontier worker's SSE proxy drops OpenRouter content chunks that
  // straddle `reader.read()` boundaries (fixed in the worker but not yet
  // deployed), which surfaces as an empty completion. Force non-streaming
  // for `frontier` until the worker fix ships; custom providers (BYO-key)
  // still stream normally.
  const useStream = options.stream === true && provider !== "frontier"

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: effectiveSettings.model || "default",
      messages: options.messages,
      max_tokens: effectiveSettings.maxTokens,
      temperature: effectiveSettings.temperature,
      stream: useStream,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // Frontier returns 402 when subscription/credits are exhausted; surface message.
    if (provider === "frontier" && res.status === 402) {
      throw new Error(`Frontier AI limit reached: ${text || "Out of credits."}`)
    }
    throw new Error(`Completion failed: ${res.status} ${text}`)
  }

  if (useStream && options.onChunk && res.body) {
    return consumeStream(res.body, options.onChunk)
  }

  const data = await res.json()
  return data.choices[0]?.message?.content?.trim() || ""
}

/**
 * Consume an OpenAI-compatible SSE stream from `/chat/completions`.
 *
 * Two correctness concerns the naive per-chunk split got wrong:
 *   1. SSE events span arbitrary `reader.read()` boundaries — we must buffer
 *      incomplete lines across reads instead of silently losing them.
 *   2. Streaming endpoints return HTTP 200 and embed errors inline
 *      (subscription limits, upstream provider failures). If we only look for
 *      `choices[0].delta.content`, those errors surface as an empty string and
 *      the user sees a blank translation. Detect `data: {"error": ...}` frames
 *      and throw so the caller can surface the message.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let full = ""

  const processLine = (line: string): "continue" | "done" => {
    if (!line.startsWith("data: ")) return "continue"
    const payload = line.slice(6).trim()
    if (!payload) return "continue"
    if (payload === "[DONE]") return "done"
    let parsed: {
      choices?: { delta?: { content?: string } }[]
      error?: string | { message?: string }
      message?: string
    }
    try { parsed = JSON.parse(payload) } catch {
      // Shouldn't happen with proper line buffering; log so we notice if upstream changes shape.
      console.warn("[completion] skipped unparseable SSE frame:", payload.slice(0, 200))
      return "continue"
    }
    if (parsed.error) {
      const msg = typeof parsed.error === "string"
        ? (parsed.message || parsed.error)
        : (parsed.error.message || parsed.message || "Completion stream error")
      throw new Error(msg)
    }
    const delta = parsed.choices?.[0]?.delta?.content || ""
    if (delta) {
      full += delta
      onChunk(full)
    }
    return "continue"
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      // Flush any trailing line left in the buffer.
      if (buffer.trim()) processLine(buffer.trim())
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "")
      buffer = buffer.slice(newlineIdx + 1)
      if (processLine(line) === "done") return full.trim()
    }
  }
  return full.trim()
}

async function buildRequestTarget(
  provider: CompletionProvider,
  settings: CompletionSettings,
  session: FrontierSession | null,
): Promise<{ url: string; headers: Record<string, string> }> {
  if (provider === "frontier") {
    if (!session?.jwt) {
      throw new Error("Sign in to use Frontier AI.")
    }
    return {
      url: FRONTIER_CHAT_URL,
      headers: { Authorization: `Bearer ${session.jwt}` },
    }
  }
  // custom: local, self-hosted, or third-party OpenAI-compatible (OpenRouter, OpenAI, Groq, ...)
  if (!settings.endpoint.trim()) {
    throw new Error("No custom endpoint configured.")
  }
  const { chatUrl } = normalizeOpenAIBaseUrl(settings.endpoint)
  const headers: Record<string, string> = {}
  const key = resolveApiKey("completion", settings.apiKey)
  if (key) headers.Authorization = `Bearer ${key}`
  return { url: chatUrl, headers }
}
