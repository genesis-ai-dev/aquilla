import type { CompletionSettings, CompletionProvider } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

export const DEFAULT_SYSTEM_PROMPT =
  "You are translating a project from {sourceLanguage} into {targetLanguage}.\n" +
  "Match the tone and formality of the provided examples. Return only the translated text — no explanations, no source text, no commentary."

export const FRONTIER_CHAT_URL = "https://api.frontierrnd.com/api/v1/chat/completions"

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

export async function fetchModels(endpoint: string): Promise<string[]> {
  const res = await fetch(`${endpoint}/v1/models`)
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
  const provider = resolveProvider(options.settings)
  const { url, headers } = await buildRequestTarget(provider, options.settings, options.session)

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: options.settings.model || "default",
      messages: options.messages,
      max_tokens: options.settings.maxTokens,
      temperature: options.settings.temperature,
      stream: options.stream || false,
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

  if (options.stream && options.onChunk && res.body) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let full = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value, { stream: true }).split("\n").filter((l) => l.startsWith("data: "))) {
        const json = line.slice(6)
        if (json === "[DONE]") break
        try { const d = JSON.parse(json).choices?.[0]?.delta?.content || ""; if (d) { full += d; options.onChunk(full) } } catch {}
      }
    }
    return full.trim()
  }

  const data = await res.json()
  return data.choices[0]?.message?.content?.trim() || ""
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
  // custom
  if (!settings.endpoint.trim()) {
    throw new Error("No custom endpoint configured.")
  }
  return {
    url: `${settings.endpoint}/v1/chat/completions`,
    headers: {},
  }
}
