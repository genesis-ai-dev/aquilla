import type { CompletionSettings, CompletionProvider, TranslationRule } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { resolveApiKey } from "@/lib/store/user-api-keys"
import { getUserProviderOverride } from "@/lib/store/user-provider-override"

// ---------------------------------------------------------------------------
// Memory primitives
// ---------------------------------------------------------------------------

/**
 * A validated source→target pair surfaced from the project's cell store.
 * Used as few-shot examples that capture this team's terminology decisions.
 */
export interface ValidatedPair {
  source: string
  target: string
}

/**
 * Extract validated source→target pairs from a snapshot of the project's
 * cells. Only cells with `status === "validated"` and non-empty content on
 * both sides are included.
 *
 * Optionally ranked by relevance to a query string: if `query` is provided,
 * pairs whose source text shares any token with the query are promoted to the
 * front. Token overlap is a cheap proxy for subject-matter similarity — good
 * enough to bias the model toward domain-relevant examples without a
 * vector store.
 *
 * @param cells - snapshot from useCells (must have `status`, `original`, `translated`)
 * @param query - optional source text of the cell being drafted (for relevance ranking)
 * @param limit - max pairs to return (default 20; callers may want fewer)
 */
export function collectValidatedPairs(
  cells: { status: string; original: string; translated: string }[],
  query?: string,
  limit = 20,
): ValidatedPair[] {
  const validated = cells.filter(
    (c) => c.status === "validated" && c.original.trim() && c.translated.trim(),
  )

  if (query && query.trim()) {
    // Token overlap: lower-case split on whitespace/punctuation
    const queryTokens = new Set(
      query.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean),
    )
    const withScore = validated.map((c) => {
      const srcTokens = c.original.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean)
      const overlap = srcTokens.filter((t) => queryTokens.has(t)).length
      return { pair: c, overlap }
    })
    withScore.sort((a, b) => b.overlap - a.overlap)
    return withScore.slice(0, limit).map((x) => ({ source: x.pair.original, target: x.pair.translated }))
  }

  return validated.slice(0, limit).map((c) => ({ source: c.original, target: c.translated }))
}

/**
 * Render active project rules as a concise terminology/guidance block that
 * can be injected into a system prompt. Only `source-requires-target` rules
 * are rendered as explicit "if you see X → use Y" guidance; other check
 * types become a simple "avoid: X" instruction. Disabled rules are skipped.
 *
 * Returns an empty string when there are no active, injectable rules.
 */
export function buildRulesBlock(rules: TranslationRule[]): string {
  const active = rules.filter((r) => r.enabled)
  if (!active.length) return ""

  const lines: string[] = []
  for (const rule of active) {
    const { check } = rule
    if (check.type === "source-requires-target") {
      lines.push(`- When the source contains "${check.sourcePattern}", the translation must include "${check.targetPattern}".`)
    } else if (check.type === "target-forbids") {
      lines.push(`- Do NOT use "${check.targetPattern}" in the translation.`)
    } else if (check.type === "source-target-match") {
      lines.push(`- The pattern "${check.pattern}" must appear in the translation when present in the source.`)
    }
    // builtin checks are algorithmic; no useful prompt injection
  }

  if (!lines.length) return ""
  return "Project terminology and style rules (MUST follow):\n" + lines.join("\n")
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a translation assistant completing a project that translates from {sourceLanguage} into {targetLanguage}.\n\n" +
  "The translation examples the user provides are your PRIMARY source of truth. They show the exact terminology, tone, register, punctuation, and stylistic conventions this specific project uses. Study them and reproduce those patterns precisely. This may be an ultra-low-resource language, so do not fall back on general knowledge of {targetLanguage} — follow the project's own patterns above all else.\n\n" +
  "Always translate from {sourceLanguage} to {targetLanguage}, relying strictly on the reference data and context provided. The language may be an ultra-low-resource language, so it is critical to follow the patterns and style of the provided reference data closely.\n\n" +
  "To produce the translation, follow these steps:\n" +
  "1. Analyze the provided reference data to understand the translation patterns and style.\n" +
  "2. Complete the translation of the given source line or passage.\n" +
  "3. Ensure your translation is consistent with the existing partial translation and surrounding context.\n" +
  "4. Pay careful attention to the provided reference data — match its terminology, register, and conventions as closely as possible.\n" +
  "5. Translate only into {targetLanguage}.\n" +
  "6. When unsure, err on the side of literalness and stay consistent with the examples.\n" +
  "7. Preserve the line breaks and any inline formatting present in the source.\n\n" +
  "Output rules (strictly enforced):\n" +
  "- Output ONLY the {targetLanguage} translation of the final source line — nothing else.\n" +
  "- No commentary, explanations, labels, headers, markdown, language names, or restated source text. Just the translated text."

// VITE_CHAT_BASE points at the chat-completion proxy. Since 2026-05-26 this
// is the aquilla-identity worker (mounted at api.aquilla.app/chat — the
// former aquilla-chat-worker was folded in to consolidate the JWT secret).
// CI wires it per-branch (prod → https://api.aquilla.app/chat, anything else
// → https://api.dev.aquilla.app/chat). Pre-migration the URL was
// aquilla.app/api/chat under the apex.
// VITE_FRONTIER_BASE is retained as a fallback so the E2E suite — which
// spins up a mock LLM server and sets that env var — keeps working.
const CHAT_BASE_FALLBACK =
  ((import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")) || ""
const CHAT_BASE_OVERRIDE =
  ((import.meta.env.VITE_CHAT_BASE as string | undefined)?.replace(/\/+$/, "")) || ""
export const FRONTIER_CHAT_URL = `${CHAT_BASE_OVERRIDE || CHAT_BASE_FALLBACK || "https://api.aquilla.app/chat"}/api/v1/chat/completions`

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/**
 * Pre-migration CompletionSettings records don't have `provider` set.
 * Infer: empty endpoint → "frontier" (new default); populated → "custom"
 * (preserves existing self-hosted/local setups). Saved-through on next write.
 */
export function resolveProvider(settings: CompletionSettings): CompletionProvider {
  if (settings.provider) return settings.provider
  // Tolerate partial records: server-synced overlays can produce a
  // completionSettings object containing only `systemPrompt` (see
  // useProject.ts overlaySettings), and legacy IDB rows predate `endpoint`.
  return (settings.endpoint ?? "").trim() ? "custom" : "frontier"
}

export function buildPrompt(options: {
  sourceLanguage: string; targetLanguage: string; systemPrompt: string
  sourceText: string; examples: { source: string; target: string }[]
  /** Active project rules — injected as a "must follow" block in the system prompt. */
  rules?: TranslationRule[]
  /** Pre-filtered validated pairs from the project — prepended to examples. */
  validatedPairs?: ValidatedPair[]
}): ChatMessage[] {
  let sys = options.systemPrompt
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  // Inject rules block after the base system prompt so it is always visible.
  if (options.rules?.length) {
    const block = buildRulesBlock(options.rules)
    if (block) sys = sys + "\n\n" + block
  }

  // Validated pairs lead the few-shot examples; search-retrieved examples follow.
  // Drop incomplete pairs (empty source or target): the branching-search corpus
  // keeps source-only cells (COALESCE(t.value,'') in loadCorpus) so in-progress
  // projects still retrieve neighbors, but an example with an empty target
  // teaches the model nothing and leaks a blank "Translation:" into the prompt.
  // Mirrors the reference impl (codex-editor shared.ts fetchFewShotExamples).
  const allExamples = [...(options.validatedPairs ?? []), ...options.examples]
    .filter((ex) => ex.source.trim() && ex.target.trim())

  let user = ""
  for (const ex of allExamples) user += `Source: ${ex.source}\nTranslation: ${ex.target}\n\n`
  user += `Source: ${options.sourceText}\nTranslation:`

  return [{ role: "system", content: sys }, { role: "user", content: user.trim() }]
}

// LLMs translate a passage substantially better than the same verses in
// isolation (pronoun antecedents, tense agreement, discourse cohesion). The
// segmented prompt asks the model to translate a whole user-selected span as
// one unit, framed with numbered <vN>...</vN> tags so the response can be
// demuxed back to individual cells. Numbered tags (not bare <v>) so a
// missing/extra tag in the response is per-cell recoverable.
const BATCH_FRAMING_INSTRUCTIONS =
  "The source is segmented with <v1>, <v2>, ... tags. " +
  "Produce a translation segmented with the same tags, in the same order, with the same count. " +
  "Do not merge, split, omit, or reorder segments."

export interface PassageExample {
  // Aligned source/target rows; rendered as mirrored <vN> in the prompt so the
  // model sees the segmented format demonstrated, not just described.
  cells: { source: string; target: string }[]
}

export function buildBatchPrompt(options: {
  sourceLanguage: string; targetLanguage: string; systemPrompt: string
  cells: { source: string }[]
  examples: PassageExample[]
  // Just-translated cells from the previous sub-batch in the same selection.
  // Rendered as a final example to give the model continuity across a chunk
  // boundary at zero token cost vs. one full extra example.
  priorBatch?: { source: string; target: string }[]
  /** Active project rules — injected as a "must follow" block in the system prompt. */
  rules?: TranslationRule[]
  /** Pre-filtered validated pairs from the project — prepended as a passage example. */
  validatedPairs?: ValidatedPair[]
}): ChatMessage[] {
  let baseSys = BATCH_FRAMING_INSTRUCTIONS + "\n\n" + options.systemPrompt
  // Inject rules block after the base system prompt.
  if (options.rules?.length) {
    const block = buildRulesBlock(options.rules)
    if (block) baseSys = baseSys + "\n\n" + block
  }

  const sys = baseSys
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  const renderSide = (rows: { source: string; target: string }[], side: "source" | "target") =>
    rows.map((r, i) => `<v${i + 1}>${side === "source" ? r.source : r.target}</v${i + 1}>`).join("\n")

  let user = ""
  // Validated pairs from the project's living memory come first — they are
  // the strongest signal of this team's terminology decisions.
  if (options.validatedPairs?.length) {
    user += `Source:\n${renderSide(options.validatedPairs, "source")}\n\nTranslation:\n${renderSide(options.validatedPairs, "target")}\n\n`
  }
  for (const ex of options.examples) {
    // Passage neighbors include source-only cells (untranslated context within
    // the retrieved span). Filter pairwise so source/target <vN> lists stay
    // aligned and no blank target leaks into the demonstrated passage.
    const cells = ex.cells.filter((c) => c.source.trim() && c.target.trim())
    if (!cells.length) continue
    user += `Source:\n${renderSide(cells, "source")}\n\nTranslation:\n${renderSide(cells, "target")}\n\n`
  }
  if (options.priorBatch?.length) {
    user += `Source:\n${renderSide(options.priorBatch, "source")}\n\nTranslation:\n${renderSide(options.priorBatch, "target")}\n\n`
  }
  const liveSource = options.cells.map((c, i) => `<v${i + 1}>${c.source}</v${i + 1}>`).join("\n")
  user += `Source:\n${liveSource}\n\nTranslation:\n`

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
  const customEndpoint = (settings.endpoint ?? "").trim()
  if (!customEndpoint) {
    throw new Error("No custom endpoint configured.")
  }
  const { chatUrl } = normalizeOpenAIBaseUrl(customEndpoint)
  const headers: Record<string, string> = {}
  const key = resolveApiKey("completion", settings.apiKey)
  if (key) headers.Authorization = `Bearer ${key}`
  return { url: chatUrl, headers }
}
