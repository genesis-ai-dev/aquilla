import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings, RuleCheck } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

export interface RuleSuggestion {
  name: string
  description: string
  severity: "major" | "minor"
  check: RuleCheck
}

const RULE_SUGGESTION_SYSTEM_PROMPT = `You are an expert translation QA analyst. Your job is to examine human-validated translation pairs and identify regex-based rules that translators should follow.

Given translation pairs, propose 1-5 rules as a JSON array. Each rule has this exact shape:

{
  "name": "Short descriptive name",
  "description": "One-sentence explanation of why this matters",
  "severity": "major" | "minor",
  "check": { /* one of three types below */ }
}

The check field must be one of:

1. Source-target match (pattern must appear in both source and target):
   { "type": "source-target-match", "pattern": "regex-string" }

2. Source requires target (if source matches, target must match):
   { "type": "source-requires-target", "sourcePattern": "regex", "targetPattern": "regex" }

3. Target forbids (target must not contain):
   { "type": "target-forbids", "targetPattern": "regex" }

GUIDELINES:
- Focus on VERIFIABLE patterns: numbers, URLs, proper nouns, specific terminology, punctuation style
- "Major" severity = critical (numbers, URLs, names, preserved content)
- "Minor" severity = style preferences (punctuation, capitalization nuances)
- Use JavaScript regex syntax. Escape backslashes in JSON: \\\\d for \\d
- DO NOT propose rules about translation accuracy or meaning — those can't be regex-checked
- DO NOT propose vague rules. Every rule must be testable by running regex.test()
- If nothing verifiable stands out, return an empty array: []

Output ONLY valid JSON. No markdown, no code fences, no explanation.`

export type UsageCallback = (meta: { kind: string; model?: string; provider: string }) => void

// ---------------------------------------------------------------------------
// FRO-198: suggest rules from mined edit candidates
// ---------------------------------------------------------------------------

/**
 * Produce a prompt body from a list of (source, target) candidate pairs,
 * annotated with their evidence strings. Passed to the same LLM system
 * prompt as `suggestRulesFromPairs`.
 */
function buildCandidatePrompt(
  candidates: { sourceSample: string; targetSample: string; evidence: string }[],
): string {
  const lines = candidates
    .slice(0, 20)
    .map(
      (c, i) =>
        `${i + 1}. Source: "${c.sourceSample}"\n   Target: "${c.targetSample}"\n   Evidence: ${c.evidence}`,
    )
    .join("\n\n")
  return `Analyze these ${Math.min(candidates.length, 20)} translation patterns (some repeated across cells, some recent edits, some from validated pairs) and propose rules:\n\n${lines}\n\nReturn a JSON array of rule suggestions.`
}

/**
 * FRO-198 entry point: given mined candidates (from edit-miner.ts), run the
 * LLM and return RuleSuggestion drafts with an aligned evidence[] string array.
 *
 * Returns `{ suggestions, evidence }` where both arrays are index-aligned.
 * On empty candidates returns empty arrays immediately without an LLM call.
 */
export async function suggestRulesFromCandidates(
  candidates: import("@/lib/rules/edit-miner").EditCandidate[],
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<{ suggestions: RuleSuggestion[]; evidence: string[] }> {
  if (candidates.length === 0) return { suggestions: [], evidence: [] }

  const prompt = buildCandidatePrompt(candidates)
  const response = await complete({
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2048), temperature: 0.2 },
    session,
    messages: [
      { role: "system", content: RULE_SUGGESTION_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  })

  onLlmCall?.({ kind: "rule-suggestion-edits", model: settings.model, provider: settings.provider || "frontier" })

  const suggestions = parseRuleSuggestions(response)

  // Build evidence strings: try to match each suggestion back to its source
  // candidate by name-overlap; fall back to the top candidate's evidence.
  const evidence = suggestions.map((s) => {
    // Simple heuristic: pick the candidate whose sourceSample appears in the
    // suggestion name/description, else use the first candidate's evidence.
    const match = candidates.find(
      (c) =>
        s.name.toLowerCase().includes(c.sourceSample.toLowerCase().slice(0, 10)) ||
        s.description.toLowerCase().includes(c.evidence.toLowerCase()),
    )
    return match?.evidence ?? candidates[0]?.evidence ?? ""
  })

  return { suggestions, evidence }
}

export async function suggestRulesFromPairs(
  pairs: { source: string; target: string }[],
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<RuleSuggestion[]> {
  if (pairs.length === 0) return []

  const sample = pairs.slice(0, 20)
  const pairsText = sample
    .map((p, i) => `${i + 1}. Source: "${p.source}"\n   Target: "${p.target}"`)
    .join("\n\n")

  const userMessage = `Analyze these ${sample.length} human-validated translation pairs and propose rules:\n\n${pairsText}\n\nReturn a JSON array of rule suggestions.`

  const response = await complete({
    // Rule suggestion overrides maxTokens and temperature; everything else flows
    // from project settings (including the provider + JWT auth path).
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2048), temperature: 0.2 },
    session,
    messages: [
      { role: "system", content: RULE_SUGGESTION_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  })

  onLlmCall?.({ kind: "rule-suggestion", model: settings.model, provider: settings.provider || "frontier" })

  return parseRuleSuggestions(response)
}

export function parseRuleSuggestions(raw: string): RuleSuggestion[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")

  // Find the first `[` and last `]` to extract the JSON array
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidSuggestion)
  } catch {
    return []
  }
}

function isValidSuggestion(s: unknown): s is RuleSuggestion {
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
