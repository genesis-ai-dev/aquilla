// Smart edits — browser client for auth-worker /api/v1/ai/smart-edits/*.
// Never throws: a failed request is "no suggestions", because nobody asked for
// them and nobody should see an error about them.

import { AUTH_BASE } from "@/lib/frontier/auth"

export const SMART_EDITS_SUGGEST_URL = `${AUTH_BASE}/api/v1/ai/smart-edits/suggest`
export const SMART_EDITS_FEEDBACK_URL = `${AUTH_BASE}/api/v1/ai/smart-edits/feedback`
export const SMART_EDITS_LLM_URL = `${AUTH_BASE}/api/v1/ai/smart-edits/llm`

export interface SmartEditExample {
  source: string
  before: string
  after: string
  ts: number
  fromAiDraft: boolean
}

/** Mirrors SmartEditSuggestion in auth-worker/src/routes/ai-smart-edits.ts. */
export interface SmartEditSuggestion {
  fileId: string
  cellId: string
  /** Offsets into the target plain text the request carried. */
  start: number
  end: number
  old: string
  oldNorm: string
  new: string
  newNorm: string
  confidence: number
  tier: "memory" | "jev" | "llm" | "harmonize"
  /** LLM tier only: the model's one-sentence reason. */
  reason?: string
  /** Harmonize tier only (AQU-1658): a flag with no replacement — no Accept. */
  flagOnly?: boolean
  /** Harmonize tier only (AQU-1657): i18n key + values explaining the check. */
  reasonKey?: string
  reasonValues?: Record<string, string>
  support: { strong: number; weak: number; keeps: number }
  examples: SmartEditExample[]
}

export interface SmartEditPassageCell {
  fileId: string
  cellId: string
  source: string
  target: string
  /** Verse reference — the harmonizer names cells by it in its reasons. */
  ref?: string
  /** Validated cells teach the harmonizer how this project writes. */
  validated?: boolean
}

function isSuggestion(v: unknown): v is SmartEditSuggestion {
  if (!v || typeof v !== "object") return false
  const s = v as Record<string, unknown>
  return (
    typeof s.cellId === "string" && typeof s.fileId === "string" &&
    typeof s.start === "number" && typeof s.end === "number" &&
    typeof s.old === "string" && typeof s.new === "string" &&
    typeof s.oldNorm === "string" && typeof s.newNorm === "string" &&
    (s.tier === "memory" || s.tier === "jev" || s.tier === "llm") && Array.isArray(s.examples)
  )
}

export async function fetchSmartEdits(
  input: { projectId: string; lane: string; cells: SmartEditPassageCell[] },
  identityToken: string,
  signal?: AbortSignal,
): Promise<SmartEditSuggestion[]> {
  try {
    const res = await fetch(SMART_EDITS_SUGGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${identityToken}` },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { suggestions?: unknown }
    return Array.isArray(body.suggestions) ? body.suggestions.filter(isSuggestion) : []
  } catch {
    return []
  }
}

export type LlmEditsResult =
  | { ok: true; suggestions: SmartEditSuggestion[] }
  | { ok: false; reason: "allowance" | "failed" }

/** Tier 2, on request: never throws; an allowance/credit cap is its own reason
 *  so the UI can say so instead of a generic failure. */
export async function requestLlmEdits(
  input: { projectId: string; lane: string; fileId: string; cellId: string; source: string; target: string; neighbors: { source: string; target: string }[] },
  identityToken: string,
): Promise<LlmEditsResult> {
  try {
    const res = await fetch(SMART_EDITS_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${identityToken}`, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(input),
    })
    if (res.status === 429) return { ok: false, reason: "allowance" }
    if (!res.ok) return { ok: false, reason: "failed" }
    const body = (await res.json()) as { suggestions?: unknown }
    return { ok: true, suggestions: Array.isArray(body.suggestions) ? body.suggestions.filter(isSuggestion) : [] }
  } catch {
    return { ok: false, reason: "failed" }
  }
}

export function sendSmartEditFeedback(
  input: {
    projectId: string
    lane: string
    suggestion: SmartEditSuggestion
    action: "accept" | "dismiss"
  },
  identityToken: string,
): void {
  const { suggestion: s } = input
  // Harmonizer suggestions are not edit-memory evidence; the memory's
  // feedback table only knows its own tiers.
  if (s.tier === "harmonize") return
  void fetch(SMART_EDITS_FEEDBACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${identityToken}` },
    body: JSON.stringify({
      projectId: input.projectId,
      lane: input.lane,
      fileId: s.fileId,
      cellId: s.cellId,
      oldNorm: s.oldNorm,
      newNorm: s.newNorm,
      action: input.action,
      tier: s.tier,
    }),
  }).catch(() => {})
}
