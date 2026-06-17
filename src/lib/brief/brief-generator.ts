// src/lib/brief/brief-generator.ts
import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { UsageCallback } from "@/lib/rules/rule-suggester"
import { assembleL2Markdown } from "./brief"
import { BRIEF_FIELDS, L1_MAX_CHARS } from "./schema"
import type { TranslationBrief } from "./types"

const L1_SYSTEM_PROMPT = `You are condensing a Bible/translation project's full translation brief into a SHORT, practical, actionable summary for an AI translation assistant.

Write direct instructions the assistant can apply on every draft: who the audience is, the purpose, the register and level of literalness, key-term and naturalness preferences, and anything it must avoid. Be concrete and imperative ("Translate for…", "Prefer…", "Avoid…").

Rules:
- Under ${L1_MAX_CHARS} characters. Tighter is better.
- No preamble, no headings, no markdown — just the guidance prose.
- Only include what the brief states; do not invent constraints.`

/** Generate the compact, always-injected L1 summary from the brief's content. */
export async function generateL1Summary(
  brief: TranslationBrief,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<string> {
  const l2 = brief.l2Markdown.trim() || assembleL2Markdown(brief)
  const response = await complete({
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 1024), temperature: 0.2 },
    session,
    messages: [
      { role: "system", content: L1_SYSTEM_PROMPT },
      { role: "user", content: `Summarize this translation brief:\n\n${l2}` },
    ],
  })
  onLlmCall?.({
    kind: "brief-generate-l1",
    model: settings.model,
    provider: settings.provider || "frontier",
  })
  const text = response.trim()
  return text.length > L1_MAX_CHARS ? text.slice(0, L1_MAX_CHARS).trimEnd() : text
}

const EXTRACT_SYSTEM_PROMPT = `You read an existing translation brief or project-guidelines document and map its content onto a fixed set of fields.

Output a single JSON object whose keys are ONLY from this list (omit any field the document does not address):
${BRIEF_FIELDS.map((f) => `- "${f.id}": ${f.label} — ${f.helperText}`).join("\n")}

Each value is a concise plain-text answer drawn from the document.
Output ONLY valid JSON — no markdown, no code fences, no commentary.`

const FIELD_IDS = new Set(BRIEF_FIELDS.map((f) => f.id))

/** Parse the extractor response into a sparse, validated parameters map. */
export function parseExtractedParameters(raw: string): Record<string, string> {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return {}
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (FIELD_IDS.has(k) && typeof v === "string" && v.trim()) out[k] = v.trim()
    }
    return out
  } catch {
    return {}
  }
}

/** Single LLM pass: document text → sparse parameters map (known ids only). */
export async function extractBriefFromDocument(
  docText: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<Record<string, string>> {
  const response = await complete({
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2048), temperature: 0.1 },
    session,
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: `Extract brief fields from this document:\n\n${docText}` },
    ],
  })
  onLlmCall?.({ kind: "brief-extract", model: settings.model, provider: settings.provider || "frontier" })
  return parseExtractedParameters(response)
}
