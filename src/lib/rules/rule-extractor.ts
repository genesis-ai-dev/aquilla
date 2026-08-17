/**
 * rule-extractor.ts — AQU-196: Two-pass LLM extraction from unstructured documents.
 *
 * Pass 1 (fast model): Extract raw candidate observations/rules as strings.
 * Pass 2 (stronger model): Convert each candidate into a structured TranslationRule draft.
 *
 * Mirrors the pattern from rule-suggester.ts.
 */

import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { RuleSuggestion } from "./rule-suggester"
import type { UsageCallback } from "./rule-suggester"
import { t } from "@/lib/i18n/standalone"

/** Max input size in bytes (~200 KB of UTF-8 text). */
export const MAX_INPUT_BYTES = 200 * 1024

export function checkInputSize(text: string): { ok: true } | { ok: false; message: string } {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_INPUT_BYTES) {
    const kb = Math.round(bytes / 1024)
    return {
      ok: false,
      message: t("rules.importDialog.documentTooLarge", { kb }),
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Pass 1 — extract raw candidates
// ---------------------------------------------------------------------------

const PASS1_SYSTEM_PROMPT = `You are an expert translation quality analyst reading a style guide, glossary, or translation guidelines document.

Extract every rule, convention, constraint, or recommendation mentioned in the document that could be verified in a translated text. Output them as a JSON array of plain-English strings — one per observation.

Examples of good observations:
- "Numbers must be preserved exactly as in the source"
- "The term 'church' must be translated as 'ekklesia'"
- "Sentences must not end with ellipsis"

Rules:
- Only include things that could be CHECKED by looking at the translation text
- Do NOT include vague instructions about tone, creativity, or meaning accuracy
- Output ONLY a valid JSON array of strings, no markdown, no code fences, no explanation
- If nothing checkable is found, return []`

export async function extractCandidates(
  docText: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<string[]> {
  const userMessage = `Extract all verifiable translation rules and conventions from this document:\n\n${docText}`

  const response = await complete({
    settings: {
      ...settings,
      // Pass 1: fast model, short output
      maxTokens: Math.min(settings.maxTokens, 2048),
      temperature: 0.1,
    },
    session,
    messages: [
      { role: "system", content: PASS1_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  })

  onLlmCall?.({
    kind: "rule-extract-pass1",
    model: settings.model,
    provider: settings.provider || "frontier",
  })

  return parseCandidates(response)
}

export function parseCandidates(raw: string): string[] {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — structure each candidate
// ---------------------------------------------------------------------------

const PASS2_SYSTEM_PROMPT = `You are an expert translation QA analyst. You will receive a plain-English description of a translation rule or constraint. Convert it into a structured rule JSON object.

The output must be a single JSON object with this exact shape:
{
  "name": "Short descriptive name (under 60 chars)",
  "description": "One-sentence explanation of why this matters",
  "severity": "major" | "minor",
  "check": { /* one of three types below */ }
}

The check field must be ONE of:
1. { "type": "source-target-match", "pattern": "regex-string" }
   Use when the same pattern must appear in both source AND target.

2. { "type": "source-requires-target", "sourcePattern": "regex", "targetPattern": "regex" }
   Use when: IF source matches sourcePattern THEN target must match targetPattern.

3. { "type": "target-forbids", "targetPattern": "regex" }
   Use when: target must NOT contain targetPattern.

Severity guide:
- "major" = numbers, URLs, proper nouns, required terminology, placeholders
- "minor" = style, punctuation, capitalization preferences

Use JavaScript regex syntax. Escape backslashes in JSON strings (\\\\d for \\d).
If the rule cannot be expressed as a regex check, output: null

Output ONLY valid JSON — a single object or null. No markdown, no explanation.`

export async function structureCandidate(
  candidate: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<RuleSuggestion | null> {
  const response = await complete({
    settings: {
      ...settings,
      // Pass 2: stronger model, controlled output
      maxTokens: Math.min(settings.maxTokens, 512),
      temperature: 0.1,
    },
    session,
    messages: [
      { role: "system", content: PASS2_SYSTEM_PROMPT },
      { role: "user", content: `Convert this rule to structured JSON:\n\n${candidate}` },
    ],
  })

  onLlmCall?.({
    kind: "rule-extract-pass2",
    model: settings.model,
    provider: settings.provider || "frontier",
  })

  return parseStructuredRule(response)
}

export function parseStructuredRule(raw: string): RuleSuggestion | null {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  if (cleaned === "null") return null
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    if (!isValidRuleSuggestion(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function isValidRuleSuggestion(s: unknown): s is RuleSuggestion {
  if (!s || typeof s !== "object") return false
  const obj = s as Record<string, unknown>
  if (typeof obj.name !== "string" || !obj.name) return false
  if (typeof obj.description !== "string") return false
  if (obj.severity !== "major" && obj.severity !== "minor") return false
  const check = obj.check as Record<string, unknown> | undefined
  if (!check || typeof check !== "object") return false
  if (check.type === "source-target-match") return typeof check.pattern === "string"
  if (check.type === "target-forbids") return typeof check.targetPattern === "string"
  if (check.type === "source-requires-target") {
    return typeof check.sourcePattern === "string" && typeof check.targetPattern === "string"
  }
  return false
}

// ---------------------------------------------------------------------------
// Orchestrator — runs both passes, calls progress callback
// ---------------------------------------------------------------------------

export interface ExtractionProgress {
  phase: "extracting" | "structuring"
  candidateCount: number
  structuredCount: number
}

export async function extractRulesFromDocument(
  docText: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onProgress?: (p: ExtractionProgress) => void,
  onLlmCall?: UsageCallback,
): Promise<RuleSuggestion[]> {
  // Pass 1
  onProgress?.({ phase: "extracting", candidateCount: 0, structuredCount: 0 })
  const candidates = await extractCandidates(docText, settings, session, onLlmCall)
  onProgress?.({ phase: "structuring", candidateCount: candidates.length, structuredCount: 0 })

  // Pass 2 — structure each candidate sequentially, updating progress
  const results: RuleSuggestion[] = []
  for (let i = 0; i < candidates.length; i++) {
    const structured = await structureCandidate(candidates[i], settings, session, onLlmCall)
    if (structured) results.push(structured)
    onProgress?.({
      phase: "structuring",
      candidateCount: candidates.length,
      structuredCount: i + 1,
    })
  }

  return results
}
