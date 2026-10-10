/**
 * Ghost-text suggestions: a generic, host-side provider registry that editor
 * extensions reach through `aquilla.suggestions.get` (apiRev 3).
 *
 * The extension renders the ghost text and decides when to ask (typically on
 * an idle caret at the end of the cell); providers decide what to offer. A
 * provider registers once at module load — the forecaster from PR #1295
 * (ghost-text forecasting, not on this branch) plugs in here with
 * `registerSuggestionProvider({ id: "forecast", suggest })` and needs no
 * bridge or extension change. The one provider shipped here is
 * translation memory over the open file: when another cell has the same
 * source and a translation that continues what is typed, offer the rest.
 */

import type { ToolSuggestion } from "../../../shared/tools/editor-api"

export interface SuggestionRequest {
  cellId: string
  fileId: string
  /** The cell's source plain text. */
  source: string
  /** Target plain text up to the caret. */
  prefix: string
}

export interface SuggestionProvider {
  id: string
  suggest: (req: SuggestionRequest) => Promise<Omit<ToolSuggestion, "source">[]> | Omit<ToolSuggestion, "source">[]
  feedback?: (cellId: string, suggestionId: string, accepted: boolean) => void
}

const providers = new Map<string, SuggestionProvider>()

export function registerSuggestionProvider(provider: SuggestionProvider): () => void {
  providers.set(provider.id, provider)
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id)
  }
}

export const MAX_SUGGESTIONS = 3
const PROVIDER_TIMEOUT_MS = 1500

/** Ask every provider; first answers win, slow providers are dropped. */
export async function suggestFor(req: SuggestionRequest): Promise<ToolSuggestion[]> {
  const asks = [...providers.values()].map(async (p) => {
    const timeout = new Promise<[]>((resolve) => setTimeout(() => resolve([]), PROVIDER_TIMEOUT_MS))
    try {
      const got = await Promise.race([Promise.resolve(p.suggest(req)), timeout])
      return got.map((s) => ({ ...s, id: `${p.id}:${s.id}`, source: p.id }))
    } catch {
      return []
    }
  })
  const all = (await Promise.all(asks)).flat()
  const seen = new Set<string>()
  return all.filter((s) => s.text && !seen.has(s.text) && seen.add(s.text)).slice(0, MAX_SUGGESTIONS)
}

export function recordSuggestionFeedback(cellId: string, suggestionId: string, accepted: boolean): void {
  const [providerId, ...rest] = suggestionId.split(":")
  providers.get(providerId)?.feedback?.(cellId, rest.join(":"), accepted)
}

/** Translation memory over a list of (source, target) pairs: the rest of a
 *  translation of the same source that starts with what is typed. */
export function memorySuggestions(
  pairs: readonly { cellId: string; source: string; target: string }[],
  req: SuggestionRequest,
): Omit<ToolSuggestion, "source">[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()
  const want = norm(req.source)
  if (!want) return []
  const out: Omit<ToolSuggestion, "source">[] = []
  for (const p of pairs) {
    if (p.cellId === req.cellId || !p.target.trim() || norm(p.source) !== want) continue
    if (!p.target.startsWith(req.prefix) || p.target.length <= req.prefix.length) continue
    out.push({ id: p.cellId, text: p.target.slice(req.prefix.length) })
  }
  return out
}

/** Pairs the memory provider reads: set by the workspace for the open file. */
let memoryPairs: () => readonly { cellId: string; source: string; target: string }[] = () => []

export function setSuggestionMemory(read: () => readonly { cellId: string; source: string; target: string }[]): () => void {
  memoryPairs = read
  return () => {
    if (memoryPairs === read) memoryPairs = () => []
  }
}

registerSuggestionProvider({ id: "memory", suggest: (req) => memorySuggestions(memoryPairs(), req) })
