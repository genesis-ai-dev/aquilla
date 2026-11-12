// Harmonizer — browser client for auth-worker /api/v1/ai/harmonize (AQU-1657).
// Never throws: a failed request is "no suggestions", because nobody asked for
// them and nobody should see an error about them.
//
// Findings come back in the smart-edits suggestion shape (tier "harmonize") so
// they share the editor's underline, popover and accept path.

import { AUTH_BASE } from "@/lib/frontier/auth"
import type { SmartEditPassageCell, SmartEditSuggestion } from "@/lib/smart-edits/client"

export const HARMONIZE_PASSAGE_URL = `${AUTH_BASE}/api/v1/ai/harmonize/passage`

interface HarmonizerSuggestionWire {
  fileId: string
  cellId: string
  start: number
  end: number
  old: string
  new: string
  confidence: number
  reasonKey: string
  reasonValues: Record<string, string>
  flagOnly?: boolean
}

function isWire(v: unknown): v is HarmonizerSuggestionWire {
  if (!v || typeof v !== "object") return false
  const s = v as Record<string, unknown>
  return (
    typeof s.cellId === "string" && typeof s.fileId === "string" &&
    typeof s.start === "number" && typeof s.end === "number" &&
    typeof s.old === "string" && typeof s.new === "string" &&
    typeof s.reasonKey === "string"
  )
}

export function toSmartEditSuggestion(w: HarmonizerSuggestionWire): SmartEditSuggestion {
  return {
    fileId: w.fileId,
    cellId: w.cellId,
    start: w.start,
    end: w.end,
    old: w.old,
    oldNorm: w.old,
    new: w.new,
    newNorm: w.new,
    confidence: typeof w.confidence === "number" ? w.confidence : 0,
    tier: "harmonize",
    ...(w.flagOnly ? { flagOnly: true } : {}),
    reasonKey: w.reasonKey,
    reasonValues: w.reasonValues && typeof w.reasonValues === "object" ? w.reasonValues : {},
    support: { strong: 0, weak: 0, keeps: 0 },
    examples: [],
  }
}

export async function fetchHarmonizerSuggestions(
  input: { projectId: string; lane: string; cells: SmartEditPassageCell[] },
  identityToken: string,
  signal?: AbortSignal,
): Promise<SmartEditSuggestion[]> {
  try {
    const res = await fetch(HARMONIZE_PASSAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${identityToken}` },
      body: JSON.stringify(input),
      signal,
    })
    if (!res.ok) return []
    const body = (await res.json()) as { suggestions?: unknown[] }
    return (body.suggestions ?? []).filter(isWire).map(toSmartEditSuggestion)
  } catch {
    return []
  }
}
