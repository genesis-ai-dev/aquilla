export const DEFAULT_SYSTEM_PROMPT =
  "You are a translation assistant. Translate from {sourceLanguage} to {targetLanguage}. Output ONLY the translation, nothing else. Do not include explanations, notes, or the original text."

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

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

export async function complete(options: {
  endpoint: string; model: string; messages: ChatMessage[]
  maxTokens: number; temperature: number; stream?: boolean
  onChunk?: (text: string) => void
}): Promise<string> {
  const res = await fetch(`${options.endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model, messages: options.messages,
      max_tokens: options.maxTokens, temperature: options.temperature,
      stream: options.stream || false,
    }),
  })
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Completion failed: ${res.status} ${t}`) }

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
